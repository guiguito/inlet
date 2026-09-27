/// <reference types="node" />
// Server only: the rest of @inlet/shared compiles without Node types, and a unit test keeps Node out of what the barrel reaches.
import { Worker } from 'node:worker_threads';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import {
  canonicalJson,
  checkTemplateForPublish,
  checkTemplateForSave,
  jsonSchemaStaticProblems,
  type ConfigCheckResult,
  type ConfigJsonSchema,
  type ConfigParameter,
  type ConfigProblem,
} from './config.js';

/**
 * The server's entry points for Remote Config template checks: `checkConfigSave` for every
 * save route and import (RC-019, RC-062), `checkConfigPublish` for publish and validate
 * (RC-052). They run the browser-safe checks of `config.ts` and add what needs a JSON
 * Schema validator (RC-015): a schema must be valid as a schema, and every default and
 * conditional value of a json parameter must be valid against it.
 *
 * Server-only, so `ajv` never reaches what the web app or the SDK import: this module is
 * the `@inlet/shared/config-check` subpath and is not re-exported from the package's barrel.
 */

/**
 * One validator for every schema. 2020-12, as RC-015 requires. `format` is an annotation and
 * asserts nothing. Not strict, so a keyword 2020-12 does not define is an annotation, as the
 * specification says, rather than an error. No schema is ever loaded: a `$ref` that does not
 * resolve inside its schema fails the compile. The generated code is not optimised: Ajv's
 * documented choice when compiling costs more than validating, as here (every save compiles,
 * a publish validates a few values); it compiles 2.6 times faster, so a template of 128
 * distinct schemas of 16 KiB publishes within the two seconds of section 11.
 */
const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: false, code: { optimize: false } });

/**
 * Compiled validators by the schema's canonical text. Ajv keys its own cache on the schema
 * object, so a fresh object per save would compile again and be kept for ever; each schema
 * is removed from Ajv's cache as soon as it is compiled, and the compiled function kept here
 * instead, bounded. The static checks forbid `$id`, so every schema registers under the one
 * empty base URI, which the next compile replaces: Ajv's reference table does not grow either.
 */
const validators = new Map<string, ValidateFunction | string>();
const VALIDATORS_MAX = 1_000;

/** The compiled validator, or the reason the schema is not valid as a schema. */
function compile(schema: ConfigJsonSchema): ValidateFunction | string {
  const key = canonicalJson(schema);
  const cached = validators.get(key);
  if (cached !== undefined) {
    validators.delete(key);
    validators.set(key, cached);
    return cached;
  }
  let result: ValidateFunction | string;
  if (!ajv.validateSchema(schema)) result = ajv.errorsText(ajv.errors, { dataVar: 'schema' });
  else {
    try {
      result = ajv.compile(schema);
    } catch (error) {
      result = error instanceof Error ? error.message : String(error);
    } finally {
      if (typeof schema === 'object') ajv.removeSchema(schema);
    }
  }
  if (validators.size >= VALIDATORS_MAX) validators.delete(validators.keys().next().value!);
  validators.set(key, result);
  return result;
}

/** RC-015: every problem with a schema, with paths under `base`. Empty when it is valid. */
export function jsonSchemaProblems(schema: unknown, base = 'schema'): Array<{ path: string; code: string; message: string }> {
  const problems = jsonSchemaStaticProblems(schema, base);
  if (problems.length > 0) return problems;
  const compiled = compile(schema as ConfigJsonSchema);
  return typeof compiled === 'string' ? [{ path: base, code: 'invalid_schema', message: `The schema is not valid: ${compiled}.` }] : [];
}

/** For tests and diagnostics: the validators held here, and the schemas Ajv's own cache holds (its meta-schemas). */
export function jsonSchemaCacheStats(): { validators: number; ajvCachedSchemas: number } {
  return { validators: validators.size, ajvCachedSchemas: (ajv as unknown as { _cache: Map<unknown, unknown> })._cache.size };
}

/** RC-019, RC-062: the save checks, and a schema's validity as a schema. */
export function checkConfigSave(raw: unknown): ConfigCheckResult {
  const result = checkTemplateForSave(raw);
  if (!result.ok) return result;
  const problems: ConfigProblem[] = [];
  result.template.parameters.forEach((parameter, index) => {
    if (parameter.type !== 'json' || parameter.schema === undefined) return;
    for (const problem of jsonSchemaProblems(parameter.schema, `parameters.${index}.schema`)) problems.push({ ...problem, parameter: parameter.key });
  });
  return problems.length > 0 ? { ok: false, problems } : result;
}

/** A json parameter with a schema, by its index in the template: what the schema phase of a publish checks. */
export type SchemaJob = { index: number; parameter: ConfigParameter }[];
export type SchemaJobResult = { invalid: ConfigProblem[]; mismatches: ConfigProblem[] };
/** What the worker is doing to one parameter: checking and compiling its schema, or checking its values. */
export type SchemaPhase = 'compile' | 'validate';

/**
 * RC-015 for a publish, per parameter: the schema's validity as a schema (a save's problem,
 * `invalid`), then its default and every conditional value against it (`mismatches`), a
 * failure naming the parameter, the condition and variant, and the JSON Pointer inside the
 * value. `onParameter` hears each index before its parameter starts. Runs in the worker of
 * `checkConfigPublish`, or in this thread when no worker can start.
 */
export function schemaJobProblems(job: SchemaJob, names: Record<string, string>, onPhase?: (index: number, phase: SchemaPhase, validatedMs: number) => void): SchemaJobResult {
  const invalid: ConfigProblem[] = [];
  const mismatches: ConfigProblem[] = [];
  // Measured here rather than by the main thread, whose view of each phase is late by a message.
  let validatedMs = 0;
  for (const { index, parameter } of job) {
    onPhase?.(index, 'compile', validatedMs);
    const schemaProblems = jsonSchemaProblems(parameter.schema, `parameters.${index}.schema`);
    if (schemaProblems.length > 0) {
      for (const problem of schemaProblems) invalid.push({ ...problem, parameter: parameter.key });
      continue;
    }
    const validate = compile(parameter.schema!) as ValidateFunction;
    // V8 compiles a function the first time it runs, and Ajv's are large: run it once on a value
    // that recurses into nothing, so that compiling ends here and the limit times only the values.
    validate(null);
    onPhase?.(index, 'validate', validatedMs);
    const started = performance.now();
    const check = (value: unknown, path: string, where: string, extra: Partial<ConfigProblem>) => {
      if (validate(value)) return;
      const error = validate.errors?.[0];
      // A missing property is named by its own path (`/headline`), not the object's that lacks it.
      const missing = error?.params.missingProperty as string | undefined;
      const valuePath = `${error?.instancePath ?? ''}${missing === undefined ? '' : `/${missing.replace(/~/g, '~0').replace(/\//g, '~1')}`}`;
      mismatches.push({
        path, parameter: parameter.key, ...extra, valuePath, code: 'schema_mismatch',
        message: `The value of ${JSON.stringify(parameter.key)} ${where} fails its schema at ${valuePath || 'the root'}: ${error?.message ?? 'invalid'}.`,
      });
    };
    check(parameter.default, `parameters.${index}.default`, 'by default', {});
    parameter.conditional.forEach((entry, entryIndex) => {
      const name = names[entry.condition] ?? entry.condition;
      check(entry.value, `parameters.${index}.conditional.${entryIndex}.value`, `under ${JSON.stringify(name)}${entry.variant !== undefined ? ` for ${JSON.stringify(entry.variant)}` : ''}`, {
        condition: entry.condition, ...(entry.variant !== undefined && { variant: entry.variant }),
      });
    });
    validatedMs += performance.now() - started;
  }
  return { invalid, mismatches };
}

// --- The schema phase off the main thread -------------------------------------------------

/**
 * RC-015: how long checking the values of one publish against their schemas may take, in all.
 * Validating is unbounded: `anyOf` branches that recurse cost twice per level of the value, so a
 * Creator's schema could hold a thread for hours. Compiling is bounded by a schema's 16 KiB and
 * does not count: the heaviest template compiles in about a second on a laptop and twice that
 * on a CI runner, which a limit shared with validation refused (DECISIONS 34.12).
 */
export const SCHEMA_CHECK_TIMEOUT_MS = 2_000;
/**
 * How long checking one schema as a schema, compiling it and running it once on `null` may take:
 * far past the tens of milliseconds a 16 KiB schema takes, a guard against one that never ends.
 */
export const SCHEMA_COMPILE_TIMEOUT_MS = 5_000;

type Stopped = { stoppedAt: number; reason: 'timeout' | 'compile-timeout' | 'failed'; error?: string };
type Job = { job: SchemaJob; names: Record<string, string>; timeoutMs: number; resolve: (result: SchemaJobResult | Stopped) => void };

let worker: Worker | null = null;
/** Set when a worker could not start here: every later publish validates in this thread. */
let workerUnavailable = false;
let queue: Promise<void> = Promise.resolve();

/** Runs one job in the persistent worker, one at a time, so each job has its whole time limit. */
function runInWorker(job: SchemaJob, names: Record<string, string>, timeoutMs: number, compileTimeoutMs: number): Promise<Parameters<Job['resolve']>[0] | null> {
  const run = () => new Promise<Parameters<Job['resolve']>[0] | null>((resolve) => {
    let started = false;
    let current = job[0]!.index;
    // The worker reports each phase as it enters it, with the time it has spent validating so
    // far; only that time, and the validation under way, use up `timeoutMs`.
    let phase: SchemaPhase = 'compile';
    let validated = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      worker ??= new Worker(new URL('./config-check-worker.js', import.meta.url));
    } catch {
      return resolve(null);
    }
    const running = worker;
    // Held only while a job runs, so an idle worker never keeps the process alive.
    running.ref();
    const finish = (value: Parameters<Job['resolve']>[0] | null) => {
      clearTimeout(timer);
      running.off('message', onMessage).off('error', onError).off('exit', onExit);
      running.unref();
      resolve(value);
    };
    const drop = () => {
      if (worker === running) worker = null;
      void running.terminate();
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        drop();
        finish({ stoppedAt: current, reason: phase === 'validate' ? 'timeout' : 'compile-timeout' });
      }, phase === 'validate' ? timeoutMs - validated : compileTimeoutMs);
    };
    const onMessage = (message: { at?: number; phase?: SchemaPhase; validatedMs?: number; done?: SchemaJobResult }) => {
      started = true;
      if (message.at !== undefined) {
        current = message.at;
        phase = message.phase ?? 'compile';
        validated = message.validatedMs ?? validated;
        arm();
      }
      if (message.done) finish(message.done);
    };
    // Before its first message, a failing worker is one that cannot start here; after it, the job failed.
    const onError = (error: Error) => {
      drop();
      finish(started ? { stoppedAt: current, reason: 'failed', error: error.message } : null);
    };
    const onExit = () => onError(new Error('the worker exited'));
    arm();
    running.on('message', onMessage).on('error', onError).on('exit', onExit);
    running.postMessage({ job, names });
  });
  const result = queue.then(run);
  queue = result.then(() => undefined);
  return result;
}

/** The schema phase: in the worker under its time limit, else here, never skipped. */
async function schemaPhase(job: SchemaJob, names: Record<string, string>, timeoutMs: number, compileTimeoutMs: number): Promise<SchemaJobResult> {
  const result = workerUnavailable ? null : await runInWorker(job, names, timeoutMs, compileTimeoutMs);
  if (result === null) {
    if (!workerUnavailable) process.emitWarning('Remote Config schema checks run on the main thread: a worker thread could not start.', { code: 'INLET_CONFIG_SCHEMA_WORKER' });
    workerUnavailable = true;
    return schemaJobProblems(job, names);
  }
  if (!('stoppedAt' in result)) return result;
  const { parameter } = job.find((entry) => entry.index === result.stoppedAt)!;
  const problem: ConfigProblem = result.reason === 'timeout'
    ? {
      path: `parameters.${result.stoppedAt}.schema`, parameter: parameter.key, code: 'schema_too_slow',
      message: `Checking the values of ${JSON.stringify(parameter.key)} against its schema took longer than ${timeoutMs / 1000} seconds. A schema whose anyOf or oneOf branches recurse costs twice per level of the value: simplify it.`,
    }
    : result.reason === 'compile-timeout'
    ? {
      path: `parameters.${result.stoppedAt}.schema`, parameter: parameter.key, code: 'schema_too_slow',
      message: `Checking the schema of ${JSON.stringify(parameter.key)} took longer than ${compileTimeoutMs / 1000} seconds. A schema whose anyOf or oneOf branches recurse can cost that much on any value: simplify it.`,
    }
    : { path: `parameters.${result.stoppedAt}.schema`, parameter: parameter.key, code: 'schema_check_failed', message: `The values of ${JSON.stringify(parameter.key)} could not be checked against its schema: ${result.error}.` };
  return { invalid: [], mismatches: [problem] };
}

/**
 * RC-052: everything a save checks, then every rule of sections 6.2 and 6.3: the
 * structural publish rules of `checkTemplateForPublish`, and the schema phase (each schema's
 * validity, then every default and conditional value of a json parameter against it),
 * which runs in a worker thread and is refused with `schema_too_slow` once checking the values
 * has taken `SCHEMA_CHECK_TIMEOUT_MS` for the whole template, or compiling one schema
 * `SCHEMA_COMPILE_TIMEOUT_MS`. On success, the template to publish, normalised as a save
 * normalises it. The two limits are parameters for tests.
 */
export async function checkConfigPublish(raw: unknown, timeoutMs = SCHEMA_CHECK_TIMEOUT_MS, compileTimeoutMs = SCHEMA_COMPILE_TIMEOUT_MS): Promise<ConfigCheckResult> {
  const saved = checkTemplateForSave(raw);
  if (!saved.ok) return saved;
  const { template } = saved;
  const job: SchemaJob = template.parameters.flatMap((parameter, index) => (parameter.type === 'json' && parameter.schema !== undefined ? [{ index, parameter }] : []));
  const names = Object.fromEntries(template.conditions.map((condition) => [condition.id, condition.name]));
  const { invalid, mismatches } = job.length === 0 ? { invalid: [], mismatches: [] } : await schemaPhase(job, names, timeoutMs, compileTimeoutMs);
  if (invalid.length > 0) return { ok: false, problems: invalid };
  const problems = [...checkTemplateForPublish(template), ...mismatches];
  return problems.length > 0 ? { ok: false, problems } : saved;
}
