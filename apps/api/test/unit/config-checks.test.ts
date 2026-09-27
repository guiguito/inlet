import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANALYTICS_PLATFORMS } from '@inlet/shared/analytics-core';
import { CONFIG_PLATFORMS } from '@inlet/shared/config-core';
import {
  checkTemplateForSave,
  CONFIG_CONDITION_ID_PATTERN,
  newConditionId,
  newConditionSalt,
  operatorsFor,
  type ConfigProblem,
  type ConfigRule,
  type ConfigTemplate,
} from '@inlet/shared';
import { checkConfigPublish, checkConfigSave, jsonSchemaCacheStats, jsonSchemaProblems, SCHEMA_CHECK_TIMEOUT_MS } from '@inlet/shared/config-check';
import { match, param, split, template } from './config-fixtures.js';

/** Remote Config PRD RC-011 to RC-023, RC-026, RC-052 and section 12's criteria on saving and publishing. */

function problems(result: ReturnType<typeof checkConfigSave>): ConfigProblem[] {
  return result.ok ? [] : result.problems;
}
const codes = (result: ReturnType<typeof checkConfigSave>) => problems(result).map((problem) => problem.code);
const withRule = (rule: Record<string, unknown>) => template([], [match('cnd_a', [rule as ConfigRule])]);

describe('save checks (RC-019)', () => {
  it('refuses a parameter key starting with a digit, naming the parameter (section 12)', () => {
    const result = checkConfigSave(template([param('1st_launch')]));
    expect(problems(result)).toEqual([expect.objectContaining({ path: 'parameters.0.key', parameter: '1st_launch', code: 'invalid_key' })]);
    expect(problems(result)[0]!.message).toContain('1st_launch');
  });

  it('accepts keys with dots and dashes, and compares keys case-sensitively', () => {
    expect(checkConfigSave(template([param('a.b-c'), param('A.b-c'), param(`k${'x'.repeat(127)}`)])).ok).toBe(true);
    expect(codes(checkConfigSave(template([param(`k${'x'.repeat(128)}`)])))).toEqual(['invalid_key']);
    expect(codes(checkConfigSave(template([param('limit'), param('limit')])))).toEqual(['duplicate_key']);
  });

  it('accepts a hand-named condition ID and those the server draws, and refuses others', () => {
    expect(CONFIG_CONDITION_ID_PATTERN.test(newConditionId())).toBe(true);
    expect(newConditionSalt()).toMatch(/^[A-Za-z0-9]{16}$/);
    const ok = template([], [match('cnd_beta1', [{ attribute: 'platform', operator: 'exists' }])]);
    expect(checkConfigSave(ok).ok).toBe(true);
    for (const id of ['cnd_Beta', 'cnd_', 'cfg_abc', `cnd_${'a'.repeat(33)}`]) {
      expect(codes(checkConfigSave(template([], [match(id, [])])))).toEqual(['invalid_condition_id']);
    }
  });

  it('refuses duplicate condition IDs, names, variant keys and experiment keys', () => {
    expect(codes(checkConfigSave(template([], [match('cnd_a', [], 'Same'), match('cnd_a', [], 'Other')])))).toEqual(['duplicate_condition_id']);
    expect(codes(checkConfigSave(template([], [match('cnd_a', [], 'Same'), match('cnd_b', [], 'Same')])))).toEqual(['duplicate_condition_name']);
    expect(codes(checkConfigSave(template([], [split('cnd_s', [['a', 5000], ['a', 5000]])])))).toEqual(['duplicate_variant_key']);
    expect(codes(checkConfigSave(template([], [split('cnd_s', [['a!', 10000]])])))).toEqual(['invalid_variant_key']);
    expect(codes(checkConfigSave(template([], [split('cnd_s', [['a', 10000]], { experiment: 'x' }), split('cnd_t', [['a', 10000]], { experiment: 'x' })])))).toEqual(['duplicate_experiment_key']);
    expect(codes(checkConfigSave(template([], [split('cnd_s', [['a', 10000]], { experiment: 'bad key' })])))).toEqual(['invalid_experiment_key']);
  });

  it('refuses the experiment keys analytics refuses, which an answer\'s experiments object cannot hold safely (RC-129)', () => {
    for (const experiment of ['__proto__', 'constructor', 'prototype']) {
      expect(codes(checkConfigSave(template([], [split('cnd_s', [['a', 10000]], { experiment })]))), experiment).toEqual(['invalid_experiment_key']);
    }
    expect(checkConfigSave(template([], [split('cnd_s', [['__proto__', 10000]], { experiment: 'proto_test' })])).ok).toBe(true);
  });

  it('refuses values of the wrong type or past their size or depth (RC-012)', () => {
    const deep = (levels: number): unknown => {
      let value: unknown = 1;
      for (let index = 0; index < levels; index += 1) value = [value];
      return value;
    };
    expect(codes(checkConfigSave(template([param('flag', { type: 'boolean', default: 'yes' })])))).toEqual(['wrong_type']);
    expect(codes(checkConfigSave(template([param('limit', { type: 'number', default: Number.NaN })])))).toEqual(['not_finite']);
    expect(codes(checkConfigSave(template([param('copy', { type: 'string', default: '€'.repeat(5462) })])))).toEqual(['value_too_large']);
    expect(checkConfigSave(template([param('copy', { type: 'string', default: '€'.repeat(5461) })])).ok).toBe(true);
    expect(codes(checkConfigSave(template([param('blob', { type: 'json', default: 'x'.repeat(64 * 1024) })])))).toEqual(['value_too_large']);
    expect(checkConfigSave(template([param('blob', { type: 'json', default: deep(32) as never })])).ok).toBe(true);
    expect(codes(checkConfigSave(template([param('blob', { type: 'json', default: deep(33) as never })])))).toEqual(['value_too_deep']);
    // A value nested far past the bound is refused, never walked into a stack overflow.
    expect(codes(checkConfigSave(template([param('blob', { type: 'json', default: deep(50_000) as never })])))).toEqual(['value_too_deep']);
    // So is a rule value: refused, and never serialized into a stack overflow when the draft is measured.
    for (const rule of [{ attribute: 'attributes.x', operator: 'in', value: [deep(200_000)] }, { attribute: 'userId', operator: 'exists', value: deep(200_000) }]) {
      expect(codes(checkConfigSave(withRule(rule)))).toEqual(['invalid_rule_value']);
    }
    const conditional = checkConfigSave(template([param('flag', { conditional: [{ condition: 'cnd_a', value: 1 }] })], [match('cnd_a', [])]));
    expect(problems(conditional)).toEqual([expect.objectContaining({ path: 'parameters.0.conditional.0.value', parameter: 'flag', condition: 'cnd_a', code: 'wrong_type' })]);
  });

  it('refuses a template past its counts', () => {
    const many = <T>(count: number, make: (index: number) => T) => Array.from({ length: count }, (_, index) => make(index));
    expect(codes(checkConfigSave(template(many(501, (index) => param(`p${index}`)))))).toEqual(['too_many_parameters']);
    expect(codes(checkConfigSave(template([], many(101, (index) => match(`cnd_${index}`, [])))))).toEqual(['too_many_conditions']);
    const rule: ConfigRule = { attribute: 'platform', operator: 'exists' };
    expect(codes(checkConfigSave(template([], [match('cnd_a', many(11, () => rule))])))).toEqual(['too_many_rules']);
    expect(codes(checkConfigSave(template([], many(6, (index) => split(`cnd_${index}`, [['a', 10000]])))))).toEqual(['too_many_splits']);
    expect(codes(checkConfigSave(template([], [split('cnd_s', many(6, (index) => [`v${index}`, 1] as [string, number]))])))).toEqual(['too_many_variants']);
  });

  it('refuses a draft past 2 MiB', () => {
    const parameters = Array.from({ length: 40 }, (_, index) => param(`p${index}`, { type: 'string', default: 'x'.repeat(16_000), conditional: [{ condition: 'cnd_a', value: 'y'.repeat(16_000) }, { condition: 'cnd_b', value: 'z'.repeat(16_000) }, { condition: 'cnd_c', value: 'w'.repeat(16_000) }] }));
    const conditions = ['cnd_a', 'cnd_b', 'cnd_c'].map((id) => match(id, [{ attribute: 'platform', operator: 'exists' }]));
    expect(codes(checkConfigSave(template(parameters, conditions)))).toEqual(['template_too_large']);
  });

  it('refuses a template that is not one, with paths', () => {
    expect(problems(checkConfigSave({ parameters: [{ key: 'a', type: 'text', default: 1 }], conditions: [] }))[0]).toMatchObject({ path: 'parameters.0.type', parameter: 'a' });
    expect(checkConfigSave({ parameters: [], conditions: [], extra: 1 }).ok).toBe(false);
    expect(checkConfigSave('nope').ok).toBe(false);
  });
});

describe('rules at save (RC-023, section 9.2)', () => {
  it('encodes the operator table', () => {
    expect(operatorsFor('platform')).toEqual(['exists', 'notExists', 'in', 'notIn']);
    expect(operatorsFor('appBuild')).toEqual(['exists', 'notExists', 'equals', 'notEquals', 'in', 'notIn', 'contains', 'startsWith', 'endsWith', 'eq', 'neq', 'lt', 'lte', 'gt', 'gte']);
    expect(operatorsFor('time')).toEqual(['before', 'after']);
    expect(operatorsFor('percentage')).toEqual(['lt']);
    expect(operatorsFor('attributes.plan')).toContain('versionGte');
    expect(operatorsFor('attributes.1plan')).toEqual([]);
  });

  it('refuses an attribute and operator pair the tables forbid', () => {
    expect(codes(checkConfigSave(withRule({ attribute: 'platform', operator: 'equals', value: 'ios' })))).toEqual(['operator_not_allowed']);
    expect(codes(checkConfigSave(withRule({ attribute: 'time', operator: 'exists' })))).toEqual(['operator_not_allowed']);
    expect(codes(checkConfigSave(withRule({ attribute: 'appVersion', operator: 'contains', value: '1' })))).toEqual(['operator_not_allowed']);
    expect(codes(checkConfigSave(withRule({ attribute: 'device', operator: 'exists' })))).toEqual(['unknown_attribute']);
    expect(codes(checkConfigSave(withRule({ attribute: 'attributes.1x', operator: 'exists' })))).toEqual(['unknown_attribute']);
    expect(codes(checkConfigSave(withRule({ attribute: 'userId', operator: 'matches', value: '.*' })))).toEqual(['unknown_operator']);
    expect(codes(checkConfigSave(withRule({ attribute: 'userId', operator: 'exists', unit: 'user' })))).toEqual(['unit_not_allowed']);
  });

  it('refuses a value of the wrong shape or past its bounds', () => {
    const bad = [
      { attribute: 'userId', operator: 'exists', value: 'a' },
      { attribute: 'userId', operator: 'equals', value: 1 },
      { attribute: 'userId', operator: 'in', value: 'a' },
      { attribute: 'userId', operator: 'in', value: [1] },
      { attribute: 'attributes.plan', operator: 'in', value: ['a', 1] },
      { attribute: 'appVersion', operator: 'versionGte', value: 'banana' },
      { attribute: 'appVersion', operator: 'versionGte', value: '01.4' },
      { attribute: 'attributes.n', operator: 'gt', value: '1' },
      { attribute: 'appBuild', operator: 'gt', value: 1.5 },
      { attribute: 'time', operator: 'after', value: '2026-02-30T00:00:00Z' },
      { attribute: 'percentage', operator: 'lt', value: 10_001 },
      { attribute: 'percentage', operator: 'lt', value: 10.5 },
      { attribute: 'platform', operator: 'in', value: ['ios', 'andriod'] },
      { attribute: 'installationId', operator: 'in', value: ['not-a-uuid'] },
    ];
    for (const rule of bad) expect(checkConfigSave(withRule(rule)).ok, JSON.stringify(rule)).toBe(false);
    expect(codes(checkConfigSave(withRule({ attribute: 'userId', operator: 'equals', value: 'x'.repeat(257) })))).toEqual(['rule_value_too_long']);
    expect(codes(checkConfigSave(withRule({ attribute: 'userId', operator: 'in', value: ['x'.repeat(257)] })))).toEqual(['rule_value_too_long']);
    expect(codes(checkConfigSave(withRule({ attribute: 'userId', operator: 'in', value: Array.from({ length: 1001 }, (_, index) => `u${index}`) })))).toEqual(['list_too_long']);
    expect(checkConfigSave(withRule({ attribute: 'userId', operator: 'in', value: Array.from({ length: 1000 }, (_, index) => `u${index}`) })).ok).toBe(true);
  });

  it('accepts each family with its value shape', () => {
    const good = [
      { attribute: 'userId', operator: 'notExists' },
      { attribute: 'userId', operator: 'in', value: [] },
      { attribute: 'userId', operator: 'notIn', value: [] },
      { attribute: 'attributes.beta', operator: 'equals', value: true },
      { attribute: 'attributes.plan', operator: 'notEquals', value: 'free' },
      { attribute: 'attributes.seats', operator: 'in', value: [1, 2, 3] },
      { attribute: 'attributes.seats', operator: 'gte', value: 10 },
      { attribute: 'attributes.sdk', operator: 'versionLt', value: 'v2.0.0-beta.1+sha.1' },
      { attribute: 'appBuild', operator: 'gte', value: 420 },
      { attribute: 'appId', operator: 'startsWith', value: 'com.example' },
      { attribute: 'osVersion', operator: 'versionGte', value: '14' },
      { attribute: 'time', operator: 'before', value: '2026-10-01T09:00:00+02:00' },
      { attribute: 'percentage', operator: 'lt', value: 0, unit: 'user' },
    ];
    for (const rule of good) expect(problems(checkConfigSave(withRule(rule))), JSON.stringify(rule)).toEqual([]);
  });

  it('normalises rule values when saved (RC-026, B.5)', () => {
    const result = checkConfigSave(template([], [match('cnd_a', [
      { attribute: 'platform', operator: 'in', value: ['IOS', 'Android'] },
      { attribute: 'country', operator: 'notIn', value: ['fr', 'Gb'] },
      { attribute: 'locale', operator: 'in', value: ['en_gb', 'ZH-hant-tw', 'es-419', 'de-DE-u-co-phonebk'] },
      { attribute: 'language', operator: 'in', value: ['EN'] },
      { attribute: 'installationId', operator: 'equals', value: 'A1B2C3D4E5F64A7B8C9D0E1F2A3B4C5D' },
      { attribute: 'installationId', operator: 'in', value: ['A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D'] },
      { attribute: 'userId', operator: 'in', value: ['CaseKept'] },
      { attribute: 'percentage', operator: 'lt', value: 1000 },
    ])]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.conditions[0]!.rules.map((rule) => rule.value)).toEqual([
      ['ios', 'android'], ['FR', 'GB'], ['en-GB', 'zh-Hant-TW', 'es-419', 'de-DE-u-co-phonebk'], ['en'],
      'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', ['a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'], ['CaseKept'], 1000,
    ]);
    expect(result.template.conditions[0]!.rules[7]!.unit).toBe('installation');
  });

  it('applies the defaults of an omitted live flag and conditional list', () => {
    const result = checkTemplateForSave({ parameters: [{ key: 'a', type: 'number', default: 1 }], conditions: [] });
    expect(result.ok && result.template.parameters[0]).toEqual({ key: 'a', type: 'number', live: false, default: 1, conditional: [] });
  });
});

describe('publish checks (RC-015, RC-016, RC-021, RC-022, RC-052)', () => {
  const publish = (value: ConfigTemplate) => checkConfigPublish(value);
  const rule: ConfigRule = { attribute: 'platform', operator: 'exists' };

  it('refuses conditional values naming what does not exist, or twice', async () => {
    const conditions = [match('cnd_m', [rule]), split('cnd_s', [['control', 5000], ['treatment', 5000]])];
    const cases: Array<[unknown[], string]> = [
      [[{ condition: 'cnd_gone', value: true }], 'unknown_condition'],
      [[{ condition: 'cnd_m', variant: 'control', value: true }], 'variant_not_allowed'],
      [[{ condition: 'cnd_s', value: true }], 'unknown_variant'],
      [[{ condition: 'cnd_s', variant: 'other', value: true }], 'unknown_variant'],
      [[{ condition: 'cnd_m', value: true }, { condition: 'cnd_m', value: false }], 'duplicate_conditional_value'],
      [[{ condition: 'cnd_s', variant: 'treatment', value: true }, { condition: 'cnd_s', variant: 'treatment', value: false }], 'duplicate_conditional_value'],
    ];
    for (const [conditional, code] of cases) {
      const result = await publish(template([param('flag', { conditional: conditional as never })], conditions));
      expect(problems(result)).toEqual([expect.objectContaining({ code, parameter: 'flag' })]);
    }
    const fine = await publish(template([param('flag', { conditional: [{ condition: 'cnd_m', value: true }, { condition: 'cnd_s', variant: 'control', value: true }, { condition: 'cnd_s', variant: 'treatment', value: false }] })], conditions));
    expect(problems(fine)).toEqual([]);
  });

  it('refuses a match condition without rules and a split without two variants summing to 100%', async () => {
    expect(codes(await publish(template([], [match('cnd_m', [])])))).toEqual(['no_rules']);
    expect(codes(await publish(template([], [split('cnd_s', [['only', 10000]])])))).toEqual(['too_few_variants']);
    expect(codes(await publish(template([], [split('cnd_s', [['a', 5000], ['b', 4999]])])))).toEqual(['weights_not_100']);
    expect(codes(await publish(template([], [split('cnd_s', [['a', 5000], ['b', 5001]])])))).toEqual(['weights_not_100']);
    expect(problems(await publish(template([], [split('cnd_s', [['a', 1], ['b', 9999]])])))).toEqual([]);
  });

  it('publishes a variant weighing 0, so a split can end on one variant and keep the others\' values', async () => {
    const ended = template(
      [param('flag', { conditional: [{ condition: 'cnd_s', variant: 'a', value: true }, { condition: 'cnd_s', variant: 'b', value: false }] })],
      [split('cnd_s', [['a', 10000], ['b', 0], ['c', 0]])],
    );
    expect(problems(await publish(ended))).toEqual([]);
    expect(codes(await publish(template([], [split('cnd_s', [['a', 0], ['b', 0]])])))).toEqual(['weights_not_100']);
  });

  it('accepts an emptied list, as erasure leaves one (RC-100)', async () => {
    expect(problems(await publish(template([], [match('cnd_m', [{ attribute: 'userId', operator: 'in', value: [] }])])))).toEqual([]);
  });

  it('refuses a conditional value lacking what its schema requires, naming the parameter, condition and path (section 12)', async () => {
    const schema = { type: 'object', required: ['headline'], properties: { plans: { type: 'array', items: { type: 'string' } } } };
    const paywall = param('paywall', {
      type: 'json', schema, default: { headline: 'Go Pro' },
      conditional: [
        { condition: 'cnd_s', variant: 'annual_first', value: { plans: ['annual'] } },
        { condition: 'cnd_m', value: { headline: 'Hi', plans: ['annual', 3] } },
      ],
    });
    const result = await publish(template([paywall], [match('cnd_m', [rule], 'Beta testers'), split('cnd_s', [['control', 5000], ['annual_first', 5000]], { name: 'Paywall copy' })]));
    expect(problems(result)).toEqual([
      expect.objectContaining({ code: 'schema_mismatch', path: 'parameters.0.conditional.0.value', parameter: 'paywall', condition: 'cnd_s', variant: 'annual_first', valuePath: '/headline' }),
      expect.objectContaining({ code: 'schema_mismatch', path: 'parameters.0.conditional.1.value', parameter: 'paywall', condition: 'cnd_m', valuePath: '/plans/1' }),
    ]);
    expect(problems(result)[0]!.message).toMatch(/paywall.*Paywall copy.*annual_first.*headline/);
    expect(codes(await publish(template([{ ...paywall, default: {}, conditional: [] }])))).toEqual(['schema_mismatch']);
  });

  it('refuses a template whose largest values sum past 512 KiB, naming the heaviest parameters (section 12)', async () => {
    const heavy = (key: string, kib: number) => param(key, { type: 'string', default: 'x'.repeat(kib * 1024 - 100) });
    const light = Array.from({ length: 10 }, (_, index) => param(`light${index}`, { type: 'string', default: 'y' }));
    const parameters = [...light, heavy('h1', 15), heavy('h2', 16), heavy('h3', 14), heavy('h4', 13), heavy('h5', 12), heavy('h6', 11)];
    for (let index = 0; index < 45; index += 1) parameters.push(heavy(`bulk${index}`, 10));
    const result = await publish(template(parameters));
    const problem = problems(result).find((item) => item.code === 'answer_too_large');
    expect(problem?.heaviest?.map((item) => item.parameter)).toEqual(['h2', 'h1', 'h3', 'h4', 'h5']);
    expect(problem?.message).toContain('h2');
    const under = await publish(template(parameters.slice(0, 20)));
    expect(problems(under)).toEqual([]);
  });

  it('counts the largest of a parameter\'s values, conditional ones included (RC-016)', async () => {
    const conditions = Array.from({ length: 40 }, (_, index) => match(`cnd_${index}`, [rule]));
    const parameters = Array.from({ length: 40 }, (_, index) => param(`p${index}`, {
      type: 'string', default: '', conditional: [{ condition: `cnd_${index}`, value: 'x'.repeat(14 * 1024) }],
    }));
    expect(codes(await publish(template(parameters, conditions)))).toEqual(['answer_too_large']);
  });

  it('validates a template at its bounds within two seconds (section 11)', async () => {
    const users = Array.from({ length: 1000 }, (_, index) => `u${index}`);
    const conditions = Array.from({ length: 100 }, (_, index) => {
      const rules: ConfigRule[] = [
        { attribute: 'userId', operator: 'notIn', value: users },
        { attribute: 'appVersion', operator: 'versionGte', value: '1.4.0' },
        { attribute: 'platform', operator: 'in', value: ['ios', 'android'] },
        { attribute: 'country', operator: 'notIn', value: ['FR', 'DE'] },
        { attribute: 'locale', operator: 'in', value: ['en-GB', 'fr-FR'] },
        { attribute: 'attributes.plan', operator: 'equals', value: 'pro' },
        { attribute: 'attributes.seats', operator: 'gte', value: 10 },
        { attribute: 'appBuild', operator: 'gt', value: 100 },
        { attribute: 'time', operator: 'after', value: '2026-01-01T00:00:00Z' },
        { attribute: 'percentage', operator: 'lt', value: 5000 },
      ];
      return index < 5 ? split(`cnd_${index}`, [['a', 2000], ['b', 2000], ['c', 2000], ['d', 2000], ['e', 2000]], { rules }) : match(`cnd_${index}`, rules);
    });
    const parameters = Array.from({ length: 500 }, (_, index) => param(`param_${index}`, {
      type: 'json',
      // A distinct schema per parameter, so each is compiled: the worst case.
      schema: { type: 'object', required: ['n'], properties: { n: { type: 'number', maximum: 1_000_000 + index } } },
      default: { n: index },
      conditional: [
        { condition: `cnd_${5 + (index % 95)}`, value: { n: 1 } },
        { condition: `cnd_${index % 5}`, variant: 'c', value: { n: 2 } },
      ],
    }));
    const value = template(parameters, conditions);
    const bytes = Buffer.byteLength(JSON.stringify(value));
    expect(bytes).toBeLessThan(2 * 1024 * 1024);
    const started = performance.now();
    const result = await publish(value);
    const elapsed = performance.now() - started;
    console.log(`publish check at the bounds (500 parameters, 100 conditions of 10 rules, 100 lists of 1,000, ${(bytes / 1e6).toFixed(2)} MB): ${elapsed.toFixed(0)} ms`);
    expect(problems(result)).toEqual([]);
    expect(elapsed).toBeLessThan(2000);
  });

  // 128 distinct schemas of about 15 KiB, never compiled before: the most compile work 2 MiB can carry.
  // `offset` makes a set of schemas new to the worker's cache of compiled ones, at the same size.
  const heaviest = (offset: number) => template(Array.from({ length: 128 }, (_, index) => {
    const properties = Object.fromEntries(Array.from({ length: 260 }, (_, at) => [`prop_${at}_${index}`, { type: 'integer', minimum: 0, maximum: 7_000 + offset + index }]));
    return param(`heavy_${index}`, { type: 'json', schema: { type: 'object', properties, required: [`prop_0_${index}`] }, default: { [`prop_0_${index}`]: 1 } });
  }));

  it('accepts a template of the heaviest schemas it can hold, however long they take to compile (RC-015, section 11)', async () => {
    const value = heaviest(0);
    expect(Buffer.byteLength(JSON.stringify(value.parameters[0]!.schema))).toBeGreaterThan(15_000);
    const started = performance.now();
    const result = await publish(value);
    const elapsed = performance.now() - started;
    console.log(`publish check of 128 distinct 15 KiB schemas, cold: ${elapsed.toFixed(0)} ms`);
    expect(problems(result)).toEqual([]);
    // About 1.2 s on a laptop and 2.2 s on a CI runner (DECISIONS 34.12); this bound catches a
    // tenfold regression without depending on the host.
    expect(elapsed).toBeLessThan(10_000);
  });

  it('counts only the checking of values toward the time limit, never the compiling (RC-015)', async () => {
    // A limit far below the second the compiling takes: the values themselves check in microseconds.
    expect(problems(await checkConfigPublish(heaviest(1_000), 50))).toEqual([]);
  });

  it('still refuses a schema whose compiling never ends, naming its parameter (RC-015)', async () => {
    // A compile limit of 1 ms, which no 15 KiB schema meets: the guard against a compile that never ends.
    expect(problems(await checkConfigPublish(heaviest(2_000), SCHEMA_CHECK_TIMEOUT_MS, 1))).toEqual([
      expect.objectContaining({ code: 'schema_too_slow', path: 'parameters.0.schema', parameter: 'heavy_0', message: expect.stringMatching(/^Checking the schema of "heavy_0" took longer than 0.001 seconds/) }),
    ]);
  });
});

describe('the time limit of the schema phase (RC-015, section 11)', () => {
  // anyOf branches that recurse cost twice per level: a value nested 32 levels would take hours.
  const exponential = { anyOf: [{ type: 'array', items: { $ref: '#' } }, { type: 'array', items: { $ref: '#' } }, { type: 'string' }] };
  const nested = (levels: number): unknown => {
    let value: unknown = 1;
    for (let index = 0; index < levels; index += 1) value = [value];
    return value;
  };

  it('refuses a schema too slow to validate, naming its parameter, while the event loop stays free', async () => {
    const slow = template([
      param('fine', { type: 'json', schema: { type: 'object' }, default: {} }),
      param('slow', { type: 'json', schema: exponential, default: nested(32) as never }),
    ]);
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 50);
    const started = performance.now();
    const result = await checkConfigPublish(slow);
    const elapsed = performance.now() - started;
    clearInterval(timer);
    expect(problems(result)).toEqual([expect.objectContaining({ code: 'schema_too_slow', path: 'parameters.1.schema', parameter: 'slow' })]);
    expect(elapsed).toBeGreaterThanOrEqual(SCHEMA_CHECK_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(2_500);
    // The validation ran in the worker: the main thread kept firing its timer.
    expect(ticks).toBeGreaterThan(25);
  });

  it('checks the next publish normally, in a restarted worker, and queues concurrent ones', async () => {
    await checkConfigPublish(template([param('slow', { type: 'json', schema: exponential, default: nested(32) as never })]), 200);
    const missing = template([param('p', { type: 'json', schema: { type: 'object', required: ['a'] }, default: {} })]);
    expect(problems(await checkConfigPublish(missing))).toEqual([expect.objectContaining({ code: 'schema_mismatch', valuePath: '/a' })]);
    const [first, second] = await Promise.all([
      checkConfigPublish(template([param('slow', { type: 'json', schema: exponential, default: nested(32) as never })]), 200),
      checkConfigPublish(missing),
    ]);
    expect(codes(first)).toEqual(['schema_too_slow']);
    expect(codes(second)).toEqual(['schema_mismatch']);
    // A value that validates quickly under the same schema publishes.
    expect(problems(await checkConfigPublish(template([param('shallow', { type: 'json', schema: exponential, default: nested(8) as never })])))).toEqual([expect.objectContaining({ code: 'schema_mismatch' })]);
    expect(problems(await checkConfigPublish(template([param('text', { type: 'json', schema: exponential, default: [['a']] as never })])))).toEqual([]);
  });
});

describe('JSON Schema (RC-015)', () => {
  const schemaCodes = (schema: unknown) => jsonSchemaProblems(schema).map((problem) => problem.code);

  it('refuses pattern and patternProperties anywhere in the tree, but not a property named pattern', () => {
    expect(schemaCodes({ type: 'string', pattern: '^(a+)+$' })).toEqual(['schema_pattern_forbidden']);
    expect(schemaCodes({ type: 'object', patternProperties: { '^x': {} } })).toEqual(['schema_pattern_forbidden']);
    expect(schemaCodes({ items: { anyOf: [{ propertyNames: { pattern: 'a' } }] } })).toEqual(['schema_pattern_forbidden']);
    expect(schemaCodes({ $defs: { a: { not: { pattern: 'a' } } } })).toEqual(['schema_pattern_forbidden']);
    expect(schemaCodes({ type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] })).toEqual([]);
    const hidden = { pattern: 'a' };
    for (const schema of [
      { properties: { a: hidden } }, { items: hidden }, { prefixItems: [true, hidden] }, { not: hidden }, { if: hidden, then: hidden, else: hidden },
      { dependentSchemas: { a: hidden } }, { propertyNames: hidden }, { contains: hidden }, { additionalProperties: hidden }, { unevaluatedItems: hidden },
      { allOf: [{ oneOf: [hidden] }] }, { 'x-unknown': hidden },
    ]) {
      expect(schemaCodes(schema).every((code) => code === 'schema_pattern_forbidden') && schemaCodes(schema).length > 0, JSON.stringify(schema)).toBe(true);
    }
    // Data may hold an object with a key named pattern: it is never a schema.
    expect(schemaCodes({ type: 'object', default: { pattern: 'stripes' }, examples: [{ pattern: 'dots' }], const: { pattern: 'stripes' } })).toEqual([]);
  });

  it('refuses a reference that would make Ajv compile data or a map of names as a schema (RC-015)', async () => {
    const evil = '^(a+)+$';
    for (const schema of [
      { default: { type: 'string', pattern: evil }, $ref: '#/default' },
      { const: { type: 'string', pattern: evil }, $ref: '#/const' },
      { examples: [{ type: 'string', pattern: evil }], $ref: '#/examples/0' },
      { enum: [{ pattern: evil }], $ref: '#/enum/0' },
      { default: { pattern: evil }, $ref: '#/%64efault' },
      { properties: { patternProperties: { [evil]: {} } }, $ref: '#/properties' },
      { $defs: { a: { default: { pattern: evil } } }, allOf: [{ $dynamicRef: '#/$defs/a/default' }] },
      { $ref: '#/$defs/missing' },
    ]) {
      expect(schemaCodes(schema), JSON.stringify(schema)).toEqual(['schema_ref_not_schema']);
    }
    // A publish never runs the hidden expression: refused before Ajv compiles it, well inside the worker's time limit.
    const started = performance.now();
    const result = await checkConfigPublish(template([param('p', { type: 'json', schema: { default: { type: 'string', pattern: evil }, $ref: '#/default' }, default: `${'a'.repeat(40)}!` })]));
    expect(codes(result)).toEqual(['schema_ref_not_schema']);
    expect(performance.now() - started).toBeLessThan(1_000);
    // References to subschemas stay allowed, a property named default included.
    for (const schema of [
      { properties: { default: { type: 'string' } }, $ref: '#/properties/default' },
      { prefixItems: [{ type: 'string' }], items: { $ref: '#/prefixItems/0' } },
      { $defs: { 'a/b~c': { type: 'string' } }, $ref: '#/$defs/a~1b~0c' },
      { $defs: { name: { $anchor: 'name', type: 'string' } }, properties: { a: { $ref: '#name' } } },
    ]) {
      expect(schemaCodes(schema), JSON.stringify(schema)).toEqual([]);
    }
  });

  it('refuses a reference outside the schema, and accepts one inside', () => {
    expect(schemaCodes({ $ref: 'https://example.com/schema.json' })).toEqual(['schema_external_ref']);
    expect(schemaCodes({ properties: { a: { $ref: 'other.json#/x' } } })).toEqual(['schema_external_ref']);
    expect(schemaCodes({ $dynamicRef: 'https://json-schema.org/draft/2020-12/schema' })).toEqual(['schema_external_ref']);
    expect(schemaCodes({ $id: 'https://example.com/a', type: 'object' })).toEqual(['schema_id_forbidden']);
    expect(schemaCodes({ $defs: { name: { type: 'string' } }, properties: { a: { $ref: '#/$defs/name' } } })).toEqual([]);
    expect(schemaCodes({ type: 'array', items: { $ref: '#' } })).toEqual([]);
    expect(schemaCodes({ $ref: '#/$defs/missing' })).toEqual(['schema_ref_not_schema']);
  });

  it('refuses a dialect other than 2020-12, and a schema that is not valid as one', () => {
    expect(schemaCodes({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' })).toEqual(['schema_dialect']);
    expect(schemaCodes({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' })).toEqual([]);
    expect(schemaCodes({ type: 'banana' })).toEqual(['invalid_schema']);
    expect(schemaCodes({ minLength: -1 })).toEqual(['invalid_schema']);
    expect(schemaCodes('object')).toEqual(['invalid_schema']);
    expect(schemaCodes(true)).toEqual([]);
    expect(schemaCodes({ description: 'x'.repeat(16 * 1024) })).toEqual(['schema_too_large']);
  });

  it('treats format and unknown keywords as annotations', async () => {
    expect(schemaCodes({ type: 'string', format: 'email', 'x-editor': { widget: 'textarea' } })).toEqual([]);
    const result = await checkConfigPublish(template([param('contact', { type: 'json', schema: { type: 'string', format: 'email' }, default: 'not an email' })]));
    expect(problems(result)).toEqual([]);
  });

  it('refuses a schema on a parameter that is not json, and a bad schema at save', () => {
    expect(codes(checkConfigSave(template([param('flag', { schema: { type: 'boolean' } })])))).toEqual(['schema_not_allowed']);
    expect(problems(checkConfigSave(template([param('blob', { type: 'json', default: {}, schema: { type: 'banana' } })])))).toEqual([expect.objectContaining({ code: 'invalid_schema', path: 'parameters.0.schema', parameter: 'blob' })]);
  });

  it('does not grow Ajv\'s cache across many compiles of distinct schema objects', () => {
    jsonSchemaProblems({ type: 'object' });
    const before = jsonSchemaCacheStats().ajvCachedSchemas;
    for (let index = 0; index < 2_000; index += 1) {
      // A fresh object each time, as a save parses one from its body.
      expect(jsonSchemaProblems({ type: 'object', properties: { [`p${index}`]: { type: 'integer', maximum: index } } })).toEqual([]);
      expect(jsonSchemaProblems({ type: 'object' })).toEqual([]);
    }
    const after = jsonSchemaCacheStats();
    expect(after.ajvCachedSchemas).toBe(before);
    expect(after.validators).toBeLessThanOrEqual(1_000);
  });

  it('still validates recursive schemas once removed from Ajv\'s cache', async () => {
    const tree = { type: 'object', required: ['name'], properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#' } } } };
    const good = { name: 'a', children: [{ name: 'b', children: [] }] };
    const bad = { name: 'a', children: [{ children: [] }] };
    expect(problems(await checkConfigPublish(template([param('tree', { type: 'json', schema: tree, default: good })])))).toEqual([]);
    expect(problems(await checkConfigPublish(template([param('tree', { type: 'json', schema: tree, default: bad })])))[0]).toMatchObject({ code: 'schema_mismatch', valuePath: '/children/0/name' });
  });
});

describe('placement (PRD Appendix C, NFR Security)', () => {
  const source = (name: string) => readFileSync(resolve(import.meta.dirname, '../../../../packages/shared/src', name), 'utf8');
  const imports = (name: string) => [...source(name).matchAll(/^import .* from '([^']+)';$/gm)].map((found) => found[1]);

  /** Every package a module reaches through its relative imports, transitively. */
  const reached = (entry: string): string[] => {
    const packages = new Set<string>();
    const seen = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
      const name = queue.pop()!;
      if (seen.has(name)) continue;
      seen.add(name);
      for (const found of source(name).matchAll(/^(?:import|export)\b[^;]*?from '([^']+)';$/gms)) {
        const from = found[1]!;
        if (from.startsWith('./')) queue.push(from.slice(2).replace(/\.js$/, '.ts'));
        else packages.add(from);
      }
    }
    return [...packages];
  };

  it('keeps ajv out of the barrel and the browser-safe modules', () => {
    expect(source('index.ts')).not.toContain('config-check');
    expect(reached('index.ts')).toEqual(['zod']);
    for (const name of ['config-core.ts', 'config.ts', 'config-evaluate.ts', 'config-template.ts']) expect(reached(name).some((from) => from.startsWith('ajv'))).toBe(false);
    expect(imports('config-check.ts')).toContain('ajv/dist/2020.js');
  });

  it('keeps the SDK-facing core free of imports, with the platforms of analytics', () => {
    expect(imports('config-core.ts')).toEqual([]);
    expect(reached('config-core.ts')).toEqual([]);
    expect([...CONFIG_PLATFORMS]).toEqual([...ANALYTICS_PLATFORMS]);
  });
});
