import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_LIMITS,
  ANALYTICS_REJECTION_CODES,
  ANALYTICS_WARNING_CODES,
  STANDARD_EVENTS,
  isPlaceholderUserId,
  validateEvent,
  type EventValidation,
} from '@inlet/shared/analytics-core';

/**
 * The analytics envelope (UX Analytics 9.1, AN-011, AN-012, AN-016), as `validateEvent`
 * applies it for the API and the SDK alike. Imported through the subpath the SDK bundles,
 * which must not need Zod.
 */
const valid = () => ({
  eventId: '0192f5a0-0000-7000-8000-000000000001',
  timestamp: '2026-09-26T10:00:00.123+02:00',
  name: 'checkout_completed',
  installationId: '0192f5a0-0000-7000-8000-0000000000aa',
  app: { version: '1.4.0' },
  sdk: { name: 'inlet-sdk', version: '0.3.0' },
});

function accepted(result: EventValidation) {
  if (!result.ok) throw new Error(`rejected: ${result.code} ${result.field ?? ''} ${result.message}`);
  return result;
}
function rejected(result: EventValidation) {
  if (result.ok) throw new Error('accepted');
  return result;
}

describe('validateEvent', () => {
  it('accepts the minimal event and fills the defaults of section 9.1', () => {
    const { event, warnings } = accepted(validateEvent(valid()));
    expect(event).toMatchObject({ platform: 'other', environment: 'production', app: { version: '1.4.0' } });
    expect(warnings).toEqual([]);
  });

  it('accepts every field of the table at its bounds', () => {
    const { event, warnings } = accepted(
      validateEvent({
        ...valid(),
        category: 'c'.repeat(32),
        userId: 'u'.repeat(128),
        sessionId: '0192f5a0-0000-7000-8000-0000000000bb',
        attribution: 'a'.repeat(128),
        experiments: { a: 'x', b: 'y', c: 'z', d: 'v'.repeat(40), ['k'.repeat(40)]: '' },
        params: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`p${i}`, i % 3 === 0 ? 's' : i % 3 === 1 ? i : true])),
        app: { version: 'v'.repeat(64), build: 'b'.repeat(64), id: 'i'.repeat(64) },
        platform: 'server',
        os: { name: 'o'.repeat(32), version: 'v'.repeat(64) },
        runtime: { name: 'r'.repeat(32), version: 'v'.repeat(32) },
        locale: 'zh-Hant-TW',
        country: 'fr',
        environment: 'e'.repeat(32),
        ephemeral: true,
        sdk: { name: 's'.repeat(64), version: 'v'.repeat(32) },
      }),
    );
    expect(warnings).toEqual([]);
    expect(event.country).toBe('FR');
    expect(event.platform).toBe('server');
    expect(Object.keys(event.params!)).toHaveLength(25);
  });

  it('refuses an unknown field naming it, nested ones included, before anything else', () => {
    expect(rejected(validateEvent({ ...valid(), breadcrumbs: [] }))).toMatchObject({ code: 'unknown_field', field: 'breadcrumbs' });
    expect(rejected(validateEvent({ ...valid(), app: { version: '1', channel: 'beta' } }))).toMatchObject({ code: 'unknown_field', field: 'app.channel' });
    expect(rejected(validateEvent({ ...valid(), os: { name: 'iOS', arch: 'arm64' } }))).toMatchObject({ code: 'unknown_field', field: 'os.arch' });
    // A typo is reported even when the event is also out of bounds.
    expect(rejected(validateEvent({ name: '1bad', extra: 1 }))).toMatchObject({ code: 'unknown_field', field: 'extra' });
  });

  it('requires eventId, timestamp, name, app.version and sdk (AN-012)', () => {
    for (const field of ['eventId', 'timestamp', 'name', 'app', 'sdk'] as const) {
      const event: Record<string, unknown> = valid();
      delete event[field];
      expect(rejected(validateEvent(event)), field).toMatchObject({ code: 'invalid_event', field });
    }
    expect(rejected(validateEvent({ ...valid(), app: {} }))).toMatchObject({ code: 'invalid_event', field: 'app.version' });
    expect(rejected(validateEvent({ ...valid(), app: { version: '' } }))).toMatchObject({ code: 'invalid_event', field: 'app.version' });
    expect(rejected(validateEvent({ ...valid(), sdk: { name: 'x' } }))).toMatchObject({ code: 'invalid_event', field: 'sdk.version' });
    expect(rejected(validateEvent('an event'))).toMatchObject({ code: 'invalid_event' });
    expect(rejected(validateEvent([valid()]))).toMatchObject({ code: 'invalid_event' });
  });

  it('refuses an event with neither identity with missing_identity, placeholders dropped first', () => {
    const { installationId: _, ...anonymous } = valid();
    expect(rejected(validateEvent(anonymous))).toMatchObject({ code: 'missing_identity' });
    expect(rejected(validateEvent({ ...anonymous, userId: 'undefined' })).code).toBe('missing_identity');
    expect(accepted(validateEvent({ ...anonymous, userId: 'u_42' })).event.userId).toBe('u_42');
  });

  it('refuses a name starting with a digit, and names at the pattern’s edges', () => {
    expect(rejected(validateEvent({ ...valid(), name: '1st_purchase' }))).toMatchObject({ code: 'invalid_event', field: 'name' });
    expect(rejected(validateEvent({ ...valid(), name: 'a'.repeat(65) }))).toMatchObject({ field: 'name' });
    expect(rejected(validateEvent({ ...valid(), name: 'has space' }))).toMatchObject({ field: 'name' });
    expect(rejected(validateEvent({ ...valid(), name: '_x' }))).toMatchObject({ field: 'name' });
    expect(accepted(validateEvent({ ...valid(), name: `A${'b'.repeat(63)}` })).event.name).toHaveLength(64);
    expect(accepted(validateEvent({ ...valid(), name: 'screen:view.v2-a_b' })).event.name).toBe('screen:view.v2-a_b');
  });

  it('accepts UUIDs in any case, with or without dashes, and returns them lowercase and dashed', () => {
    const { event } = accepted(
      validateEvent({ ...valid(), eventId: '0192F5A0000070008000000000000001', installationId: '0192F5A0-0000-7000-8000-0000000000AA', sessionId: '0192f5a0000070008000000000000abc' }),
    );
    expect(event.eventId).toBe('0192f5a0-0000-7000-8000-000000000001');
    expect(event.installationId).toBe('0192f5a0-0000-7000-8000-0000000000aa');
    expect(event.sessionId).toBe('0192f5a0-0000-7000-8000-000000000abc');
    for (const field of ['eventId', 'installationId', 'sessionId']) {
      expect(rejected(validateEvent({ ...valid(), [field]: 'not-a-uuid' })), field).toMatchObject({ code: 'invalid_event', field });
      expect(rejected(validateEvent({ ...valid(), [field]: 42 })), field).toMatchObject({ code: 'invalid_event', field });
    }
  });

  it('requires an RFC 3339 timestamp with an offset, on a real calendar day', () => {
    for (const timestamp of ['2026-09-26T10:00:00Z', '2026-09-26t10:00:00z', '2026-09-26T10:00:00.5-05:30', '2026-02-28T23:59:59+00:00']) {
      expect(accepted(validateEvent({ ...valid(), timestamp })).event.timestamp).toBe(timestamp);
    }
    for (const timestamp of ['2026-09-26T10:00:00', '2026-09-26 10:00:00Z', '2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-09-26T24:00:00Z', 1790000000000, 'yesterday']) {
      expect(rejected(validateEvent({ ...valid(), timestamp })), String(timestamp)).toMatchObject({ code: 'invalid_event', field: 'timestamp' });
    }
  });

  it('refuses each bound that is not truncated, naming its path', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ userId: 'u'.repeat(129) }, 'userId'],
      [{ userId: 7 }, 'userId'],
      [{ experiments: { a: '1', b: '2', c: '3', d: '4', e: '5', f: '6' } }, 'experiments'],
      [{ experiments: { 'bad key': 'x' } }, 'experiments.bad key'],
      [{ experiments: { ['k'.repeat(41)]: 'x' } }, `experiments.${'k'.repeat(41)}`],
      [{ experiments: { ok: 'v'.repeat(41) } }, 'experiments.ok'],
      [{ experiments: { ok: 1 } }, 'experiments.ok'],
      [{ experiments: ['a'] }, 'experiments'],
      [{ params: Object.fromEntries(Array.from({ length: 26 }, (_, i) => [`p${i}`, i])) }, 'params'],
      [{ params: { '1st': 1 } }, 'params.1st'],
      [{ params: { ['p'.repeat(41)]: 1 } }, `params.${'p'.repeat(41)}`],
      [{ params: { nested: { a: 1 } } }, 'params.nested'],
      [{ params: { list: [1] } }, 'params.list'],
      [{ params: { nothing: null } }, 'params.nothing'],
      [{ params: { inf: Number.POSITIVE_INFINITY } }, 'params.inf'],
      [{ params: { nan: Number.NaN } }, 'params.nan'],
      [{ app: { version: 'v'.repeat(65) } }, 'app.version'],
      [{ app: { version: '1', build: 'b'.repeat(65) } }, 'app.build'],
      [{ app: { version: '1', id: 'i'.repeat(65) } }, 'app.id'],
      [{ app: '1.4.0' }, 'app'],
      [{ platform: 'playstation' }, 'platform'],
      [{ os: { name: 'o'.repeat(33) } }, 'os.name'],
      [{ os: { version: 'v'.repeat(65) } }, 'os.version'],
      [{ runtime: { name: 'r'.repeat(33) } }, 'runtime.name'],
      [{ runtime: { version: 'v'.repeat(33) } }, 'runtime.version'],
      [{ locale: 'l'.repeat(36) }, 'locale'],
      [{ locale: 'not a locale' }, 'locale'],
      [{ country: 'FRA' }, 'country'],
      [{ country: 'F1' }, 'country'],
      [{ environment: 'e'.repeat(33) }, 'environment'],
      [{ environment: '' }, 'environment'],
      [{ ephemeral: 'yes' }, 'ephemeral'],
      [{ sdk: { name: 's'.repeat(65), version: '1' } }, 'sdk.name'],
      [{ sdk: { name: 's', version: 'v'.repeat(33) } }, 'sdk.version'],
      [{ category: 5 }, 'category'],
      [{ attribution: false }, 'attribution'],
    ];
    for (const [overrides, field] of cases) {
      expect(rejected(validateEvent({ ...valid(), ...overrides })), field).toMatchObject({ code: 'invalid_event', field });
    }
  });

  it('reads a null optional field as absent, at the top level and inside app, os and runtime', () => {
    const { event, warnings } = accepted(
      validateEvent({
        ...valid(),
        category: null,
        userId: null,
        sessionId: null,
        attribution: null,
        experiments: null,
        params: null,
        platform: null,
        os: { name: null, version: '14' },
        runtime: null,
        locale: null,
        country: null,
        environment: null,
        ephemeral: null,
        app: { version: '1.4.0', build: null, id: null },
      }),
    );
    expect(warnings).toEqual([]);
    expect(event).toEqual({
      eventId: valid().eventId,
      timestamp: valid().timestamp,
      name: 'checkout_completed',
      installationId: valid().installationId,
      app: { version: '1.4.0' },
      platform: 'other',
      os: { version: '14' },
      environment: 'production',
      sdk: { name: 'inlet-sdk', version: '0.3.0' },
    });
    // A null installation ID beside a user ID is no installation ID: the event is the user's.
    expect(accepted(validateEvent({ ...valid(), installationId: null, userId: 'u1' })).event).not.toHaveProperty('installationId');
    expect(rejected(validateEvent({ ...valid(), installationId: null }))).toMatchObject({ code: 'missing_identity' });
  });

  it('still refuses a null required field and a null param value', () => {
    for (const [overrides, field] of [
      [{ eventId: null }, 'eventId'],
      [{ timestamp: null }, 'timestamp'],
      [{ name: null }, 'name'],
      [{ app: null }, 'app'],
      [{ app: { version: null } }, 'app.version'],
      [{ sdk: null }, 'sdk'],
      [{ sdk: { name: null, version: '1' } }, 'sdk.name'],
      [{ sdk: { name: 's', version: null } }, 'sdk.version'],
      [{ params: { plan: null } }, 'params.plan'],
      [{ experiments: { checkout: null } }, 'experiments.checkout'],
    ] as [Record<string, unknown>, string][]) {
      expect(rejected(validateEvent({ ...valid(), ...overrides })), field).toMatchObject({ code: 'invalid_event', field });
    }
    // An unknown field is unknown whatever its value.
    expect(rejected(validateEvent({ ...valid(), channel: null }))).toMatchObject({ code: 'unknown_field', field: 'channel' });
  });

  it('truncates a string param, an attribution and a category with a truncated warning', () => {
    const { event, warnings } = accepted(
      validateEvent({ ...valid(), params: { note: 'x'.repeat(1_000), n: 3 }, attribution: 'a'.repeat(200), category: 'c'.repeat(40) }),
    );
    expect(event.params!.note).toHaveLength(256);
    expect(event.params!.n).toBe(3);
    expect(event.attribution).toHaveLength(128);
    expect(event.category).toHaveLength(32);
    expect(warnings).toEqual([
      { code: 'truncated', field: 'category' },
      { code: 'truncated', field: 'attribution' },
      { code: 'truncated', field: 'params.note' },
    ]);
  });

  it('truncates before an emoji at the 256 boundary, never through it', () => {
    const value = `${'a'.repeat(255)}😀tail`;
    const { event } = accepted(validateEvent({ ...valid(), params: { p: value } }));
    expect(event.params!.p).toBe('a'.repeat(255));
    const exact = `${'a'.repeat(254)}😀`;
    expect(accepted(validateEvent({ ...valid(), params: { p: exact } })).event.params!.p).toBe(exact);
    // The same at the category's 32 and the attribution's 128, each with its warning.
    const cut = accepted(validateEvent({ ...valid(), category: `${'c'.repeat(31)}😀`, attribution: `${'a'.repeat(127)}😀` }));
    expect(cut.event.category).toBe('c'.repeat(31));
    expect(cut.event.attribution).toBe('a'.repeat(127));
    expect(cut.warnings.map((warning) => warning.field)).toEqual(['category', 'attribution']);
    // A bound that is refused rather than truncated counts the pair as two units, as every envelope does.
    expect(rejected(validateEvent({ ...valid(), userId: `${'u'.repeat(127)}😀` }))).toMatchObject({ code: 'invalid_event', field: 'userId' });
  });

  it('cleans U+0000 and a lone surrogate from every string, keys included, before validating', () => {
    const { event, warnings } = accepted(
      validateEvent({ ...valid(), params: { ['k\u0000ey']: 'a\u0000b\uD800c' }, userId: 'u\uDC00', attribution: 'x\u0000' }),
    );
    expect(event.params).toEqual({ key: 'ab�c' });
    expect(event.userId).toBe('u�');
    expect(event.attribution).toBe('x');
    expect(warnings).toEqual([]);
    // A name made valid by removing U+0000 is accepted; one made of a lone surrogate is not.
    expect(accepted(validateEvent({ ...valid(), name: 'sign\u0000up' })).event.name).toBe('signup');
    expect(rejected(validateEvent({ ...valid(), name: '\uD800' })).field).toBe('name');
  });

  it('drops placeholder user IDs with placeholder_user_id (AN-016)', () => {
    for (const userId of ['undefined', 'NULL', ' none ', 'nil', 'Anonymous', 'guest', 'unknown', '0', '-1', '', '   ', '00000000-0000-0000-0000-000000000000', '00000000000000000000000000000000']) {
      const { event, warnings } = accepted(validateEvent({ ...valid(), userId }));
      expect(event.userId, JSON.stringify(userId)).toBeUndefined();
      expect(warnings, JSON.stringify(userId)).toEqual([{ code: 'placeholder_user_id', field: 'userId' }]);
    }
    for (const userId of ['user-0', 'nullable', '00000000-0000-0000-0000-000000000001']) expect(isPlaceholderUserId(userId), userId).toBe(false);
  });

  it('refuses an event above 8 KiB after truncation with event_too_large, and keeps one that fits', () => {
    // 25 params of 256 three-byte characters: under every field bound, far over 8 KiB.
    const heavy = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`p${i}`, '€'.repeat(256)]));
    expect(rejected(validateEvent({ ...valid(), params: heavy }))).toMatchObject({ code: 'event_too_large' });
    // Long values that truncation brings under 8 KiB are accepted, with warnings.
    const long = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`p${i}`, 'x'.repeat(2_000)]));
    const result = accepted(validateEvent({ ...valid(), params: long }));
    expect(result.warnings).toHaveLength(25);
    expect(new TextEncoder().encode(JSON.stringify(result.event)).length).toBeLessThanOrEqual(ANALYTICS_LIMITS.eventMaxBytes);
  });

  it('never throws, whatever it is given', () => {
    for (const raw of [null, undefined, 0, true, Symbol.iterator, () => 1, Object.create(null), { toString: 1 }]) {
      expect(() => validateEvent(raw)).not.toThrow();
    }
  });

  it('never throws on deeply nested or circular values, which it refuses at their field', () => {
    // A 40 KB body parses to 20,000 levels; recursing into it overflowed the stack, which
    // ingest would have answered with a 5xx for a condition of the data (AN-018).
    let deep = '1';
    for (let i = 0; i < 20_000; i += 1) deep = `[${deep}]`;
    const nested = JSON.parse(`{"a":${deep}}`) as Record<string, unknown>;
    expect(rejected(validateEvent({ ...valid(), params: nested }))).toMatchObject({ code: 'invalid_event', field: 'params.a' });
    expect(rejected(validateEvent({ ...valid(), app: { version: nested } }))).toMatchObject({ code: 'invalid_event', field: 'app.version' });
    expect(rejected(validateEvent({ ...valid(), extra: nested }))).toMatchObject({ code: 'unknown_field', field: 'extra' });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(rejected(validateEvent({ ...valid(), params: circular }))).toMatchObject({ code: 'invalid_event', field: 'params.self' });
  });

  it('treats a __proto__ key as the field it is named, never as a prototype', () => {
    const json = (fields: string) =>
      JSON.parse(`{${fields},"eventId":"0192f5a0-0000-7000-8000-000000000001","timestamp":"2026-09-26T10:00:00Z","installationId":"0192f5a0-0000-7000-8000-0000000000aa","app":{"version":"1"},"sdk":{"name":"s","version":"1"}}`);
    expect(rejected(validateEvent(json('"name":"x","__proto__":{"a":1}')))).toMatchObject({ code: 'unknown_field', field: '__proto__' });
    // A name smuggled in a prototype is not the event's name.
    expect(rejected(validateEvent(json('"__proto__":{"name":"smuggled"}')))).toMatchObject({ code: 'unknown_field', field: '__proto__' });
    expect(rejected(validateEvent({ ...valid(), app: JSON.parse('{"version":"1","__proto__":{"a":1}}') }))).toMatchObject({ code: 'unknown_field', field: 'app.__proto__' });
    // A param or experiment key that the patterns allow is kept, not silently lost.
    const { event } = accepted(validateEvent({ ...valid(), params: JSON.parse('{"__proto__":"x","n":1}'), experiments: JSON.parse('{"__proto__":"B"}') }));
    expect(Object.entries(event.params!)).toEqual([['__proto__', 'x'], ['n', 1]]);
    expect(Object.entries(event.experiments!)).toEqual([['__proto__', 'B']]);
    expect(rejected(validateEvent({ ...valid(), params: JSON.parse('{"__proto__":{"a":1}}') }))).toMatchObject({ code: 'invalid_event', field: 'params.__proto__' });
  });

  it('allows exactly 8 KiB and refuses one byte more', () => {
    const bytes = (params: Record<string, string>) => {
      const result = validateEvent({ ...valid(), params });
      return result.ok ? new TextEncoder().encode(JSON.stringify(result.event)).length : Number.POSITIVE_INFINITY;
    };
    // Ten values of 256 three-byte characters (7,680 bytes), then ASCII to land on the bound.
    const params: Record<string, string> = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`p${i}`, '€'.repeat(256)]));
    params.z = '';
    params.z = 'x'.repeat(ANALYTICS_LIMITS.eventMaxBytes - bytes(params));
    expect(params.z.length).toBeLessThanOrEqual(256);
    expect(bytes(params)).toBe(ANALYTICS_LIMITS.eventMaxBytes);
    expect(accepted(validateEvent({ ...valid(), params })).warnings).toEqual([]);
    expect(rejected(validateEvent({ ...valid(), params: { ...params, z: `${params.z}x` } }))).toMatchObject({ code: 'event_too_large' });
  });
});

describe('the rest of the contract', () => {
  it('names the codes of section 7.1 and the standard events of AN-040 to AN-045', () => {
    expect(ANALYTICS_REJECTION_CODES).toHaveLength(9);
    expect(ANALYTICS_WARNING_CODES).toEqual(['truncated', 'placeholder_user_id', 'param_key_limit', 'category_limit', 'clock_corrected']);
    expect(Object.keys(STANDARD_EVENTS)).toEqual(['app_installed', 'app_updated', 'app_started', 'session_crashed', 'screen_viewed']);
    expect(Object.keys(STANDARD_EVENTS.app_started.params)).toEqual(['trigger', 'crashReporting']);
    expect(Object.keys(STANDARD_EVENTS.session_crashed.params)).toEqual(['kind', 'crashedAt']);
    for (const standard of Object.values(STANDARD_EVENTS)) expect(standard.description.length).toBeLessThanOrEqual(ANALYTICS_LIMITS.descriptionMaxLength);
  });
});
