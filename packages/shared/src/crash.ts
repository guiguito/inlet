import { z } from 'zod';
import { CRASH_LIMITS, CRASH_PLATFORMS, KIND_REQUIRES, normalizeUuid, truncateCrashText, utf8Length } from './crash-core.js';

/**
 * The crash envelope schema (Crash Reports PRD section 9.1, CR-011, CR-012), on top of
 * the dependency-free contract in `crash-core.ts`. The API validates with this; the SDK
 * enforces the same bounds from `CRASH_LIMITS` without zod (FD-013).
 */
export * from './crash-core.js';

const bounded = (max: number) => z.string().max(max);
const kindSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'kind is lowercase letters, digits and single hyphens');

export const crashFrameSchema = z.strictObject({
  function: bounded(128).optional(),
  file: bounded(128).optional(),
  line: z.number().int().nonnegative().optional(),
  col: z.number().int().nonnegative().optional(),
  inApp: z.boolean(),
});

export const crashExceptionSchema = z.strictObject({
  type: bounded(128),
  /**
   * Truncated rather than rejected (section 9.1): the message is the one field a
   * client cannot bound in advance, and losing the whole report over it helps nobody.
   */
  message: z.string().transform((value) => truncateCrashText(value, CRASH_LIMITS.messageMaxLength)),
  handled: z.boolean(),
  frames: z.array(crashFrameSchema).max(CRASH_LIMITS.framesMax),
});

export const crashNativeSchema = z.strictObject({
  process: bounded(32),
  fault: bounded(32),
  module: bounded(128),
  dumpBytes: z.number().int().nonnegative().optional(),
});

export const crashExitSchema = z.strictObject({
  code: z.number().int().optional(),
  signal: bounded(16).optional(),
  reason: bounded(64).optional(),
  name: bounded(64).optional(),
  lastUptimeMs: z.number().int().nonnegative().optional(),
});

const eventIdSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i, 'eventId is a UUID or 32 hex characters');

/**
 * CR-118, UX Analytics §9.1: a UUID in any letter case, with or without dashes, stored
 * and returned lowercase and dashed. Shared by crash reports and feedback submissions.
 */
export const identityUuidSchema = z
  .string()
  .max(36)
  .transform((value, ctx) => {
    const normalized = normalizeUuid(value);
    if (normalized === null) {
      ctx.addIssue({ code: 'custom', message: 'Must be a UUID.' });
      return z.NEVER;
    }
    return normalized;
  });

/**
 * Section 9.1, exactly. `strictObject` is what implements CR-011: an unknown top-level
 * key fails validation with the key's path, which the API turns into `unknown_field`.
 */
export const crashEnvelopeSchema = z
  .strictObject({
    eventId: eventIdSchema,
    timestamp: z.iso.datetime({ offset: true }),
    sdk: z.strictObject({ name: z.string().min(1).max(64), version: z.string().min(1).max(32) }),
    platform: z.enum(CRASH_PLATFORMS).optional(),
    kind: kindSchema,
    release: z.strictObject({
      version: z.string().min(1).max(64),
      build: bounded(64).optional(),
      channel: bounded(32).optional(),
    }),
    environment: z.string().min(1).max(32).default('production'),
    exception: crashExceptionSchema.optional(),
    native: crashNativeSchema.optional(),
    exit: crashExitSchema.optional(),
    os: z.strictObject({ name: bounded(32), version: bounded(64).optional(), arch: bounded(16).optional() }).optional(),
    runtime: z.strictObject({ name: bounded(32), version: bounded(32).optional() }).optional(),
    user: z.strictObject({ id: z.string().min(1).max(CRASH_LIMITS.userIdMaxLength) }).optional(),
    // CR-118: the shared SDK identity (Foundations FD-016).
    installationId: identityUuidSchema.optional(),
    sessionId: identityUuidSchema.optional(),
    tags: z
      .record(z.string().min(1).max(64), z.string().max(256))
      .refine((tags) => Object.keys(tags).length <= CRASH_LIMITS.tagsMax, `at most ${CRASH_LIMITS.tagsMax} tags`)
      .optional(),
    context: z
      .record(z.string(), z.unknown())
      .refine((value) => utf8Length(JSON.stringify(value)) <= CRASH_LIMITS.contextMaxBytes, 'context exceeds 16 KiB')
      .optional(),
    fingerprint: z
      .array(z.string().min(1).max(CRASH_LIMITS.fingerprintPartMaxLength))
      .min(1)
      .max(CRASH_LIMITS.fingerprintPartsMax)
      .optional(),
  })
  .superRefine((envelope, ctx) => {
    // CR-012: the block the kind needs must be present. Custom kinds carry whatever they like.
    const required = (KIND_REQUIRES as Record<string, 'exception' | 'native' | 'exit' | undefined>)[envelope.kind];
    if (required && envelope[required] === undefined) {
      ctx.addIssue({ code: 'custom', path: [required], message: `${required} is required for kind ${envelope.kind}` });
    }
  });

export type CrashEnvelope = z.infer<typeof crashEnvelopeSchema>;
export type CrashEnvelopeInput = z.input<typeof crashEnvelopeSchema>;
export type CrashFrame = z.infer<typeof crashFrameSchema>;

