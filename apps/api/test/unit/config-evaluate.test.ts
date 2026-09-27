import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  bucket,
  checkTemplateForSave,
  compareVersions,
  compileTemplate,
  configEtag,
  parseContext,
  parseVersion,
  type ConfigContext,
  type ConfigTemplate,
} from '@inlet/shared';
import { installationIds, match, param, split, template } from './config-fixtures.js';

/** Remote Config PRD section 6.4, RC-041, Appendix B, and section 12's criteria on evaluation. */

const NOW = Date.parse('2026-09-27T12:00:00Z');

function answer(value: ConfigTemplate, context: ConfigContext, now = NOW) {
  const compiled = compileTemplate(value);
  return compiled.resolve(compiled.evaluate(context, now));
}

function version(value: string) {
  const parsed = parseVersion(value);
  if (!parsed) throw new Error(`unparsed ${value}`);
  return parsed;
}

describe('version comparison (B.2)', () => {
  it('appVersion versionGte 1.4.0 holds and fails exactly as section 12 says', () => {
    const value = template([param('on', { conditional: [{ condition: 'cnd_v', value: true }] })], [match('cnd_v', [{ attribute: 'appVersion', operator: 'versionGte', value: '1.4.0' }])]);
    const at = (appVersion: string) => answer(value, parseContext({ app: { version: appVersion } }).context).values.on;
    for (const yes of ['1.4.0', '1.4', '1.10.0', '2.0.0-beta.1', 'v1.4.0', '1.4.0+build.7', '1.4.0.1']) expect(at(yes), yes).toBe(true);
    for (const no of ['1.3.9', '1.4.0-rc.1', 'banana', '1.4.0.0.1', '01.4.0', '']) expect(at(no), no).toBe(false);
  });

  it('orders pre-releases as SemVer 2.0.0 section 11', () => {
    const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
    for (let index = 1; index < ordered.length; index += 1) {
      expect(compareVersions(version(ordered[index - 1]!), version(ordered[index]!)), `${ordered[index - 1]} < ${ordered[index]}`).toBe(-1);
      expect(compareVersions(version(ordered[index]!), version(ordered[index - 1]!))).toBe(1);
    }
    expect(compareVersions(version('1.4'), version('1.4.0.0'))).toBe(0);
    expect(compareVersions(version('1.4.0+a'), version('1.4.0+b'))).toBe(0);
    expect(compareVersions(version('99999999999999999999.0'), version('99999999999999999998.9'))).toBe(1);
  });

  it('compares strings as given under in and notIn', () => {
    const value = template([param('on', { conditional: [{ condition: 'cnd_v', value: true }] })], [match('cnd_v', [{ attribute: 'appVersion', operator: 'in', value: ['1.4.0'] }])]);
    expect(answer(value, { app: { version: '1.4' } }).values.on).toBe(false);
    expect(answer(value, { app: { version: '1.4.0' } }).values.on).toBe(true);
  });
});

describe('evaluation order (RC-030, B.1)', () => {
  it('with A then B both true, takes A\'s value, else B\'s, else the default (section 12)', () => {
    const always = [{ attribute: 'platform' as const, operator: 'exists' as const }];
    const value = template(
      [
        param('both', { type: 'string', default: 'default', conditional: [{ condition: 'cnd_b', value: 'B' }, { condition: 'cnd_a', value: 'A' }] }),
        param('onlyB', { type: 'string', default: 'default', conditional: [{ condition: 'cnd_b', value: 'B' }] }),
        param('neither', { type: 'string', default: 'default' }),
      ],
      [match('cnd_a', always), match('cnd_b', always)],
    );
    expect(answer(value, { platform: 'ios' }).values).toEqual({ both: 'A', onlyB: 'B', neither: 'default' });
    expect(answer(value, {}).values).toEqual({ both: 'default', onlyB: 'default', neither: 'default' });
  });

  it('the worked example of B.6', () => {
    const betaTesters = ['tester-1', 'tester-2'];
    const value = template(
      [param('new_checkout', { default: false, conditional: [{ condition: 'cnd_early', value: true }, { condition: 'cnd_150', value: false }] })],
      [
        match('cnd_150', [{ attribute: 'appVersion', operator: 'versionEquals', value: '1.5.0' }], '1.5.0'),
        match('cnd_beta', [{ attribute: 'userId', operator: 'in', value: betaTesters }], 'Beta testers'),
        match('cnd_early', [{ attribute: 'percentage', operator: 'lt', value: 1000, unit: 'installation' }], 'Early rollout'),
      ],
    );
    const salt = value.conditions[2]!.salt;
    const ids = installationIds(200);
    const inside = ids.find((id) => bucket(salt, 'p', id) < 1000)!;
    const outside = ids.find((id) => bucket(salt, 'p', id) >= 1000)!;
    const compiled = compileTemplate(value);
    const run = (context: ConfigContext) => compiled.explain(context, NOW);

    const on150 = run({ userId: 'tester-1', installationId: inside, app: { version: '1.5.0' } });
    expect(on150.values.new_checkout).toBe(false);
    expect(on150.parameters[0]!.source).toEqual({ kind: 'condition', condition: 'cnd_150', name: '1.5.0' });

    const on151 = run({ userId: 'tester-1', installationId: inside, app: { version: '1.5.1' } });
    expect(on151.values.new_checkout).toBe(true);
    expect(on151.conditions.map((condition) => condition.result)).toEqual([false, true, true]);
    expect(on151.parameters[0]!.source).toEqual({ kind: 'condition', condition: 'cnd_early', name: 'Early rollout' });

    const other = run({ userId: 'someone', installationId: outside, app: { version: '1.5.1' } });
    expect(other.values.new_checkout).toBe(false);
    expect(other.parameters[0]!.source).toEqual({ kind: 'default' });
    expect(other.conditions.map((condition) => condition.firstFalseRule)).toEqual([0, 0, 0]);
  });
});

describe('missing attributes (RC-025)', () => {
  it('userId notIn [a, b] is false without a user ID, and userId notExists true (section 12)', () => {
    const value = template(
      [param('notIn', { conditional: [{ condition: 'cnd_n', value: true }] }), param('notExists', { conditional: [{ condition: 'cnd_x', value: true }] })],
      [match('cnd_n', [{ attribute: 'userId', operator: 'notIn', value: ['a', 'b'] }]), match('cnd_x', [{ attribute: 'userId', operator: 'notExists' }])],
    );
    expect(answer(value, {}).values).toEqual({ notIn: false, notExists: true });
    expect(answer(value, { userId: 'c' }).values).toEqual({ notIn: true, notExists: false });
    expect(answer(value, { userId: 'a' }).values).toEqual({ notIn: false, notExists: false });
  });

  it('matches only a context value of the rule\'s own type', () => {
    const rules = (rule: object) => template([param('on', { conditional: [{ condition: 'cnd_r', value: true }] })], [match('cnd_r', [rule as never])]);
    const on = (rule: object, attributes: Record<string, string | number | boolean>) => answer(rules(rule), { attributes }).values.on;
    expect(on({ attribute: 'attributes.seats', operator: 'eq', value: 1 }, { seats: 1 })).toBe(true);
    expect(on({ attribute: 'attributes.seats', operator: 'eq', value: 1 }, { seats: '1' })).toBe(false);
    expect(on({ attribute: 'attributes.plan', operator: 'equals', value: 'pro' }, { plan: 'pro' })).toBe(true);
    expect(on({ attribute: 'attributes.beta', operator: 'equals', value: true }, { beta: 'true' })).toBe(false);
    expect(on({ attribute: 'attributes.beta', operator: 'equals', value: true }, { beta: true })).toBe(true);
    expect(on({ attribute: 'attributes.plan', operator: 'notEquals', value: 'free' }, { plan: 3 })).toBe(false);
    expect(on({ attribute: 'attributes.plan', operator: 'notIn', value: ['free'] }, { plan: 3 })).toBe(false);
    expect(on({ attribute: 'attributes.seats', operator: 'in', value: [1, 2] }, { seats: 2 })).toBe(true);
    expect(on({ attribute: 'attributes.seats', operator: 'in', value: [1, 2] }, { seats: '2' })).toBe(false);
    // An attribute named like an Object.prototype member is read as an own property only.
    expect(on({ attribute: 'attributes.constructor', operator: 'exists' }, {})).toBe(false);
    const { context } = parseContext({ attributes: { constructor: 'x', toString: 2 } });
    expect(answer(rules({ attribute: 'attributes.constructor', operator: 'equals', value: 'x' }), context).values.on).toBe(true);
    expect(answer(rules({ attribute: 'attributes.toString', operator: 'eq', value: 2 }), context).values.on).toBe(true);
  });

  it('holds notExists for every attribute a context does not carry, and nothing else', () => {
    const present: ConfigContext = {
      installationId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', userId: 'u', platform: 'ios', os: { version: '17' }, app: { version: '1.0', build: '1', id: 'com.x' },
      locale: 'en-GB', language: 'en', country: 'GB', attributes: { plan: 'pro' },
    };
    for (const attribute of ['installationId', 'userId', 'platform', 'osVersion', 'appVersion', 'appBuild', 'appId', 'locale', 'language', 'country', 'attributes.plan']) {
      const value = template([param('on', { conditional: [{ condition: 'cnd_x', value: true }] })], [match('cnd_x', [{ attribute, operator: 'notExists' }])]);
      expect(answer(value, {}).values.on, attribute).toBe(true);
      expect(answer(value, present).values.on, attribute).toBe(false);
      const exists = template([param('on', { conditional: [{ condition: 'cnd_x', value: true }] })], [match('cnd_x', [{ attribute, operator: 'exists' }])]);
      expect(answer(exists, present).values.on, attribute).toBe(true);
      // Every other operator is false on a missing attribute (RC-025).
      const inList = template([param('on', { conditional: [{ condition: 'cnd_x', value: true }] })], [match('cnd_x', [{ attribute, operator: 'notIn', value: [] }])]);
      expect(answer(inList, {}).values.on, attribute).toBe(false);
    }
  });

  it('reads in [] as never and notIn [] as any value of the attribute', () => {
    const on = (rule: object, context: ConfigContext) => answer(template([param('on', { conditional: [{ condition: 'cnd_r', value: true }] })], [match('cnd_r', [rule as never])]), context).values.on;
    expect(on({ attribute: 'userId', operator: 'in', value: [] }, { userId: 'u' })).toBe(false);
    expect(on({ attribute: 'userId', operator: 'notIn', value: [] }, { userId: 'u' })).toBe(true);
    expect(on({ attribute: 'attributes.seats', operator: 'notIn', value: [] }, { attributes: { seats: 3 } })).toBe(true);
    expect(on({ attribute: 'attributes.seats', operator: 'in', value: [] }, { attributes: { seats: 3 } })).toBe(false);
  });

  it('applies appBuild\'s number operators only when both sides are decimal integers', () => {
    const value = template([param('on', { conditional: [{ condition: 'cnd_b', value: true }] })], [match('cnd_b', [{ attribute: 'appBuild', operator: 'gte', value: 420 }])]);
    expect(answer(value, { app: { build: '420' } }).values.on).toBe(true);
    expect(answer(value, { app: { build: '1000' } }).values.on).toBe(true);
    expect(answer(value, { app: { build: '419' } }).values.on).toBe(false);
    expect(answer(value, { app: { build: '420a' } }).values.on).toBe(false);
  });

  it('holds `before X` while now < X and `after X` from X on', () => {
    const at = '2026-10-01T00:00:00Z';
    const instant = Date.parse(at);
    const value = template(
      [param('before', { conditional: [{ condition: 'cnd_b', value: true }] }), param('after', { conditional: [{ condition: 'cnd_a', value: true }] })],
      [match('cnd_b', [{ attribute: 'time', operator: 'before', value: at }]), match('cnd_a', [{ attribute: 'time', operator: 'after', value: at }])],
    );
    expect(answer(value, {}, instant - 1).values).toEqual({ before: true, after: false });
    expect(answer(value, {}, instant).values).toEqual({ before: false, after: true });
  });
});

describe('buckets (B.3, RC-024, RC-022)', () => {
  const ids = installationIds(100_000);

  it('is the first four bytes of SHA-256 over salt:tag:unit, modulo 10,000', () => {
    const id = ids[0]!;
    const digest = createHash('sha256').update(`abcdefgh12345678:p:${id}`).digest();
    expect(bucket('abcdefgh12345678', 'p', id)).toBe(digest.readUInt32BE(0) % 10_000);
    // The tags keep a split's population percentage independent of its variants.
    const differ = ids.slice(0, 1000).filter((unit) => bucket('abcdefgh12345678', 'p', unit) !== bucket('abcdefgh12345678', 'v', unit)).length;
    expect(differ).toBeGreaterThan(990);
  });

  const rollout = (percent: number, salt: string) => ({
    parameters: [param('on', { conditional: [{ condition: 'cnd_r', value: true }] })],
    conditions: [{ id: 'cnd_r', name: 'Rollout', kind: 'match' as const, salt, rules: [{ attribute: 'percentage', operator: 'lt' as const, value: percent, unit: 'installation' as const }] }],
  });
  const included = (value: ConfigTemplate) => {
    const compiled = compileTemplate(value);
    return new Set(ids.filter((installationId) => compiled.evaluate({ installationId }, NOW) === 't'));
  };

  it('10% includes 9% to 11%; 50% keeps every one of them; a new salt changes which (section 12)', () => {
    const ten = included(rollout(1000, 'q8Zt0bLm3Rx9Kc2V'));
    expect(ten.size).toBeGreaterThanOrEqual(9_000);
    expect(ten.size).toBeLessThanOrEqual(11_000);
    const fifty = included(rollout(5000, 'q8Zt0bLm3Rx9Kc2V'));
    expect([...ten].every((id) => fifty.has(id))).toBe(true);
    expect(fifty.size).toBeGreaterThan(49_000);
    const reshuffled = included(rollout(1000, 'Z0z9Y8y7X6x5W4w3'));
    const kept = [...ten].filter((id) => reshuffled.has(id)).length;
    expect(kept).toBeLessThan(ten.size * 0.2);
  });

  it('a 50/50 split assigns 49% to 51% to each variant, with the experiment inside its population only (section 12)', () => {
    const value = template([], [split('cnd_s', [['control', 5000], ['treatment', 5000]], { experiment: 'paywall_copy', rules: [{ attribute: 'platform', operator: 'in', value: ['ios', 'android'] }] })]);
    const compiled = compileTemplate(value);
    const counts = { control: 0, treatment: 0 };
    for (const installationId of ids) {
      const { experiments } = compiled.resolve(compiled.evaluate({ installationId, platform: 'ios' }, NOW));
      counts[experiments.paywall_copy as keyof typeof counts] += 1;
    }
    for (const count of Object.values(counts)) {
      expect(count).toBeGreaterThanOrEqual(49_000);
      expect(count).toBeLessThanOrEqual(51_000);
    }
    expect(compiled.resolve(compiled.evaluate({ installationId: ids[0]!, platform: 'web' }, NOW)).experiments).toEqual({});
  });

  it('gives control, which holds no value, the next true condition\'s value, else the default (section 12)', () => {
    const value = template(
      [
        param('paywall', { type: 'string', default: 'default', conditional: [{ condition: 'cnd_s', variant: 'annual_first', value: 'annual' }, { condition: 'cnd_m', value: 'match' }] }),
        param('other', { type: 'string', default: 'default', conditional: [{ condition: 'cnd_s', variant: 'annual_first', value: 'annual' }] }),
      ],
      [split('cnd_s', [['control', 5000], ['annual_first', 5000]], { experiment: 'paywall_copy' }), match('cnd_m', [{ attribute: 'platform', operator: 'exists' }])],
    );
    const compiled = compileTemplate(value);
    const control = ids.find((installationId) => compiled.evaluate({ installationId }, NOW)[0] === '0')!;
    const annual = ids.find((installationId) => compiled.evaluate({ installationId }, NOW)[0] === '1')!;
    const at = (installationId: string) => compiled.resolve(compiled.evaluate({ installationId, platform: 'ios' }, NOW));
    expect(at(control)).toEqual({ values: { paywall: 'match', other: 'default' }, experiments: { paywall_copy: 'control' } });
    expect(at(annual)).toEqual({ values: { paywall: 'annual', other: 'annual' }, experiments: { paywall_copy: 'annual_first' } });
  });

  it('moving weights from 50/50 to 60/40 moves only installations from the second variant to the first (section 12)', () => {
    const before = split('cnd_s', [['a', 5000], ['b', 5000]]);
    const after = { ...before, variants: [{ key: 'a', weight: 6000 }, { key: 'b', weight: 4000 }] };
    const first = compileTemplate(template([], [before]));
    const second = compileTemplate(template([], [after]));
    let moved = 0;
    for (const installationId of ids) {
      const from = first.evaluate({ installationId }, NOW);
      const to = second.evaluate({ installationId }, NOW);
      if (from !== to) {
        expect([from, to]).toEqual(['1', '0']);
        moved += 1;
      }
    }
    expect(moved).toBeGreaterThan(9_000);
    expect(moved).toBeLessThan(11_000);
  });

  it('matches no condition bucketed by installation for a context without one (section 12)', () => {
    const value = template(
      [param('on', { default: false, conditional: [{ condition: 'cnd_p', value: true }, { condition: 'cnd_s', variant: 'a', value: true }] })],
      [match('cnd_p', [{ attribute: 'percentage', operator: 'lt', value: 10_000, unit: 'installation' }]), split('cnd_s', [['a', 10_000]])],
    );
    const compiled = compileTemplate(value);
    expect(compiled.resolve(compiled.evaluate({ userId: 'u1' }, NOW))).toEqual({ values: { on: false }, experiments: {} });
    const explained = compiled.explain({ userId: 'u1' }, NOW);
    expect(explained.conditions.map(({ result, firstFalseRule, unitMissing }) => ({ result, firstFalseRule, unitMissing }))).toEqual([
      { result: false, firstFalseRule: 0, unitMissing: true },
      { result: false, firstFalseRule: undefined, unitMissing: true },
    ]);
    expect(compiled.resolve(compiled.evaluate({ installationId: ids[0]! }, NOW)).values.on).toBe(true);
  });

  it('puts a bucket equal to a cumulative bound in the next variant, and gives a zero-weight variant no unit (B.3)', () => {
    const salt = 'Hs7yP1eW4dN0gT6u';
    const id = ids.find((unit) => bucket(salt, 'v', unit) > 0 && bucket(salt, 'v', unit) < 9_999)!;
    const at = bucket(salt, 'v', id);
    const variant = (weights: number[]) => {
      const condition = { ...split('cnd_s', weights.map((weight, index) => [`v${index}`, weight] as [string, number])), salt };
      return compileTemplate(template([], [condition])).evaluate({ installationId: id }, NOW);
    };
    expect(variant([at, 10_000 - at])).toBe('1');
    expect(variant([at + 1, 9_999 - at])).toBe('0');
    expect(variant([at, 0, 10_000 - at])).toBe('2');
    const ended = compileTemplate(template([], [split('cnd_e', [['a', 0], ['b', 10_000], ['c', 0]])]));
    expect(new Set(ids.slice(0, 5_000).map((installationId) => ended.evaluate({ installationId }, NOW)))).toEqual(new Set(['1']));
  });

  it('includes no unit at 0 and every unit at 10,000', () => {
    const count = (percent: number) => included(rollout(percent, 'q8Zt0bLm3Rx9Kc2V')).size;
    expect(count(0)).toBe(0);
    expect(count(10_000)).toBe(ids.length);
  });

  it('draws a split\'s population percentage (p) independently of its variants (v)', () => {
    const value = template([], [split('cnd_s', [['a', 5000], ['b', 5000]], { rules: [{ attribute: 'percentage', operator: 'lt', value: 5000, unit: 'installation' }] })]);
    const compiled = compileTemplate(value);
    const outcomes = ids.map((installationId) => compiled.evaluate({ installationId }, NOW));
    const inside = outcomes.filter((outcome) => outcome !== '-');
    const first = inside.filter((outcome) => outcome === '0').length;
    // Were the tags the same, every unit under 50% would also fall in the first half of the variants.
    expect(inside.length).toBeGreaterThan(49_000);
    expect(first / inside.length).toBeGreaterThan(0.48);
    expect(first / inside.length).toBeLessThan(0.52);
  });

  it('buckets users by the user ID as sent', () => {
    const value = template([param('on', { conditional: [{ condition: 'cnd_u', value: true }] })], [match('cnd_u', [{ attribute: 'percentage', operator: 'lt', value: 5000, unit: 'user' }])]);
    const salt = value.conditions[0]!.salt;
    for (const userId of ['Alice', 'alice', 'bob', 'carol']) {
      expect(answer(value, { userId }).values.on).toBe(bucket(salt, 'p', userId) < 5000);
    }
  });
});

describe('context (RC-041, section 9.2, B.5)', () => {
  it('ignores an unknown field and treats a 1,000-character attribute as absent, reporting it (section 12)', () => {
    const { context, warnings } = parseContext({ unknownField: { deep: true }, attributes: { plan: 'x'.repeat(1000), seats: 3 } });
    expect(context).toEqual({ attributes: { seats: 3 } });
    expect(warnings).toEqual([{ path: 'attributes.plan', code: 'invalid' }]);
    const value = template([param('on', { conditional: [{ condition: 'cnd_p', value: true }] })], [match('cnd_p', [{ attribute: 'attributes.plan', operator: 'notExists' }])]);
    expect(answer(value, context).values.on).toBe(true);
  });

  it('normalises as B.5 says', () => {
    const { context, warnings } = parseContext({
      installationId: 'A1B2C3D4E5F64A7B8C9D0E1F2A3B4C5D', userId: 'User-1', platform: 'IOS', os: { name: 'iOS', version: '17.4' },
      app: { version: '1.5.0', build: '420', id: 'com.example' }, locale: 'zh_hant_tw', country: 'fr', deriveCountry: false,
      sdk: { name: 'inlet-sdk', version: '0.4.0' }, etag: 'abc',
    });
    expect(warnings).toEqual([]);
    expect(context).toEqual({
      installationId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', userId: 'User-1', platform: 'ios', os: { name: 'iOS', version: '17.4' },
      app: { version: '1.5.0', build: '420', id: 'com.example' }, locale: 'zh-Hant-TW', language: 'zh', country: 'FR', deriveCountry: false,
      sdk: { name: 'inlet-sdk', version: '0.4.0' }, etag: 'abc',
    });
  });

  it('treats each field past its bounds as absent, with its path', () => {
    const { context, warnings } = parseContext({
      installationId: 'not-a-uuid', userId: 'u'.repeat(129), platform: 'playstation', os: 'ios', app: { version: 'v'.repeat(65), build: 7 },
      locale: 'english please', country: 'FRA', deriveCountry: 'no', sdk: { name: 'n'.repeat(65) }, etag: 'e'.repeat(65),
    });
    expect(context).toEqual({});
    expect(warnings.map((warning) => warning.path)).toEqual([
      'installationId', 'userId', 'platform', 'os', 'app.version', 'app.build', 'locale', 'country', 'deriveCountry', 'sdk.name', 'etag',
    ]);
  });

  it('treats placeholder user IDs as absent (AN-016) and null as absence', () => {
    for (const userId of ['null', 'Anonymous', ' guest ', '', '00000000-0000-0000-0000-000000000000']) {
      expect(parseContext({ userId })).toEqual({ context: {}, warnings: [{ path: 'userId', code: 'placeholder_user_id' }] });
    }
    expect(parseContext({ userId: null, platform: null, attributes: { a: null } })).toEqual({ context: {}, warnings: [] });
    expect(parseContext([1])).toEqual({ context: {}, warnings: [{ path: '', code: 'invalid' }] });
  });

  it('drops an invalid attribute alone, and every valid one past the twentieth', () => {
    const attributes: Record<string, unknown> = { '1bad': 'x', ok: Number.POSITIVE_INFINITY, nested: { a: 1 } };
    for (let index = 0; index < 22; index += 1) attributes[`a${index}`] = index;
    const { context, warnings } = parseContext({ attributes });
    expect(Object.keys(context.attributes!)).toHaveLength(20);
    expect(warnings).toEqual([
      { path: 'attributes.1bad', code: 'invalid' }, { path: 'attributes.ok', code: 'invalid' }, { path: 'attributes.nested', code: 'invalid' },
      { path: 'attributes.a20', code: 'too_many_attributes' }, { path: 'attributes.a21', code: 'too_many_attributes' },
    ]);
  });
});

describe('ETag (B.4)', () => {
  const beta = ['beta-1', 'beta-2'];
  const base = template(
    [param('limit', { type: 'number', default: 10, live: true, conditional: [{ condition: 'cnd_ios', value: 20 }] }), param('copy', { type: 'string', default: 'hi' })],
    [match('cnd_beta', [{ attribute: 'userId', operator: 'in', value: beta }], 'Beta'), match('cnd_ios', [{ attribute: 'platform', operator: 'in', value: ['ios'] }], 'iOS')],
  );
  const etag = (value: ConfigTemplate, context: ConfigContext) => {
    const compiled = compileTemplate(value);
    return configEtag('cfg_1', { ...compiled.resolve(compiled.evaluate(context, NOW)), live: compiled.live });
  };

  it('is unchanged by a publish that changes only a value under a condition false for the context (section 12)', () => {
    const next = structuredClone(base);
    next.parameters[0]!.conditional[0]!.value = 30;
    expect(etag(next, { platform: 'android' })).toBe(etag(base, { platform: 'android' }));
    expect(etag(next, { platform: 'ios' })).not.toBe(etag(base, { platform: 'ios' }));
  });

  it('is the same for a user on a beta list that gives no parameter a value as for one off it (section 12)', () => {
    expect(etag(base, { userId: 'beta-1' })).toBe(etag(base, { userId: 'someone-else' }));
  });

  it('is unchanged by a parameter reorder, and depends on the database', () => {
    const reordered = { ...base, parameters: [...base.parameters].reverse() };
    expect(etag(reordered, { platform: 'ios' })).toBe(etag(base, { platform: 'ios' }));
    const compiled = compileTemplate(base);
    const resolved = { ...compiled.resolve(compiled.evaluate({}, NOW)), live: compiled.live };
    expect(configEtag('cfg_2', resolved)).not.toBe(configEtag('cfg_1', resolved));
    expect(configEtag('cfg_1', null)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(configEtag('cfg_1', null)).not.toBe(configEtag('cfg_1', { values: {}, experiments: {}, live: [] }));
    const digest = createHash('sha256').update('cfg_1:unpublished').digest().subarray(0, 16).toString('base64url');
    expect(configEtag('cfg_1', null)).toBe(digest);
  });

  it('is unchanged when a parameter\'s conditional values are listed in another order', () => {
    const reordered = structuredClone(base);
    reordered.parameters[0]!.conditional.unshift({ condition: 'cnd_beta', value: 25 });
    const listedLast = structuredClone(base);
    listedLast.parameters[0]!.conditional.push({ condition: 'cnd_beta', value: 25 });
    for (const context of [{ platform: 'ios' as const }, { userId: 'beta-1', platform: 'ios' as const }, {}]) {
      expect(etag(reordered, context)).toBe(etag(listedLast, context));
    }
  });

  it('changes when a parameter becomes live', () => {
    const live = structuredClone(base);
    live.parameters[1]!.live = true;
    expect(etag(live, {})).not.toBe(etag(base, {}));
  });

  it('is the same with the server’s native digest as with the shared one, on an answer of many blocks', () => {
    const native = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest();
    const big = { values: { copy: 'é€😀', blocks: Array.from({ length: 200 }, (_, i) => ({ id: i, title: `Block ${i}` })) }, experiments: { paywall: 'b' }, live: ['copy'] };
    expect(configEtag('cfg_1', big, native)).toBe(configEtag('cfg_1', big));
    expect(configEtag('cfg_1', null, native)).toBe(configEtag('cfg_1', null));
  });
});

describe('preview (RC-060)', () => {
  it('gives exactly what evaluate and resolve give, for many contexts', () => {
    const value = template(
      [
        param('a', { type: 'number', default: 0, conditional: [{ condition: 'cnd_s', variant: 'x', value: 1 }, { condition: 'cnd_m', value: 2 }] }),
        param('b', { type: 'string', default: '', live: true, conditional: [{ condition: 'cnd_p', value: 'p' }] }),
      ],
      [
        split('cnd_s', [['x', 3000], ['y', 7000]], { rules: [{ attribute: 'platform', operator: 'in', value: ['ios'] }] }),
        match('cnd_m', [{ attribute: 'appVersion', operator: 'versionLt', value: '2.0' }]),
        match('cnd_p', [{ attribute: 'percentage', operator: 'lt', value: 2500, unit: 'installation' }]),
      ],
    );
    const compiled = compileTemplate(value);
    expect(compiled.live).toEqual(['b']);
    const platforms = ['ios', 'android', undefined] as const;
    installationIds(300).forEach((installationId, index) => {
      const context: ConfigContext = { installationId, ...(platforms[index % 3] && { platform: platforms[index % 3] }), app: { version: index % 2 ? '1.9' : '2.1' } };
      const explained = compiled.explain(context, NOW);
      const resolved = compiled.resolve(compiled.evaluate(context, NOW));
      expect({ values: explained.values, experiments: explained.experiments }).toEqual(resolved);
      expect(Object.fromEntries(explained.parameters.map((parameter) => [parameter.key, parameter.value]))).toEqual(resolved.values);
      expect(explained.problems).toEqual([]);
    });
  });

  it('gives exactly what evaluate and resolve give, on random valid templates (seeded)', () => {
    let seed = 20260927;
    const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const rules = [
      { attribute: 'platform', operator: 'in', value: ['ios'] }, { attribute: 'userId', operator: 'notExists' }, { attribute: 'userId', operator: 'equals', value: 'u1' },
      { attribute: 'appVersion', operator: 'versionGte', value: '1.5' }, { attribute: 'percentage', operator: 'lt', value: 3000, unit: 'installation' },
      { attribute: 'percentage', operator: 'lt', value: 6000, unit: 'user' }, { attribute: 'attributes.seats', operator: 'gt', value: 2 },
      { attribute: 'time', operator: 'after', value: '2026-09-01T00:00:00Z' }, { attribute: 'country', operator: 'notIn', value: ['FR'] },
    ] as const;
    const contexts = installationIds(40).map((installationId, index): ConfigContext => ({
      ...(index % 4 !== 0 && { installationId }), ...(index % 3 === 0 && { userId: `u${index % 5}` }), ...(index % 2 === 0 && { platform: 'ios' }),
      app: { version: pick(['1.4', '1.5.0', '2.0.0-beta.1']) }, attributes: { seats: index % 5 }, ...(index % 6 === 0 && { country: 'FR' }),
    }));
    for (let round = 0; round < 50; round += 1) {
      const count = 1 + Math.floor(random() * 6);
      const conditions = Array.from({ length: count }, (_, index) => {
        const chosen = Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({ ...pick(rules) }) as never);
        return random() < 0.3 && index < 5
          ? split(`cnd_${index}`, [['a', 2500], ['b', 0], ['c', 7500]], { experiment: `e${index}`, unit: pick(['installation', 'user'] as const), rules: random() < 0.5 ? [] : chosen })
          : match(`cnd_${index}`, chosen);
      });
      const parameters = Array.from({ length: 8 }, (_, index) => param(`p${index}`, {
        type: 'number', default: -1,
        conditional: conditions.filter(() => random() < 0.5).map((condition, entry) => ({
          condition: condition.id, ...(condition.kind === 'split' && { variant: pick(['a', 'b', 'c']) }), value: index * 100 + entry,
        })).sort(() => random() - 0.5),
      }));
      const value = template(parameters, conditions);
      const checked = checkTemplateForSave(value);
      if (!checked.ok) throw new Error(JSON.stringify(checked.problems));
      const compiled = compileTemplate(checked.template);
      for (const context of contexts) {
        const explained = compiled.explain(context, NOW);
        const resolved = compiled.resolve(compiled.evaluate(context, NOW));
        expect({ values: explained.values, experiments: explained.experiments }).toEqual(resolved);
        expect(Object.fromEntries(explained.parameters.map((parameter) => [parameter.key, parameter.value]))).toEqual(resolved.values);
        expect(explained.problems).toEqual([]);
        // B.1 read directly: the first true condition, in priority order, holding a value for the parameter.
        for (const parameter of checked.template.parameters) {
          const winner = checked.template.conditions.findIndex((condition, index) => {
            const detail = explained.conditions[index]!;
            return detail.result && parameter.conditional.some((entry) => entry.condition === condition.id && (condition.kind === 'match' || entry.variant === detail.variant));
          });
          const expected = winner < 0 ? parameter.default : parameter.conditional.find((entry) => entry.condition === checked.template.conditions[winner]!.id && (entry.variant === undefined || entry.variant === explained.conditions[winner]!.variant))!.value;
          expect(resolved.values[parameter.key]).toBe(expected);
        }
      }
    }
  });

  it('evaluates a draft as it stands, naming what it could not evaluate', () => {
    const value = template(
      [param('on', { default: false, conditional: [{ condition: 'cnd_gone', value: true }, { condition: 'cnd_s', variant: 'a', value: true }, { condition: 'cnd_m', value: true }] })],
      [split('cnd_s', [['a', 5000], ['b', 4000]]), match('cnd_empty', []), match('cnd_m', [{ attribute: 'platform', operator: 'exists' }])],
    );
    const compiled = compileTemplate(value);
    const explained = compiled.explain({ installationId: installationIds(1)[0]!, platform: 'ios' }, NOW);
    expect(explained.values).toEqual({ on: true });
    expect(explained.parameters[0]!.source).toEqual({ kind: 'condition', condition: 'cnd_m', name: 'cnd_m' });
    expect(explained.conditions.map(({ id, result, notEvaluated }) => ({ id, result, notEvaluated }))).toEqual([
      { id: 'cnd_s', result: false, notEvaluated: true },
      { id: 'cnd_empty', result: false, notEvaluated: true },
      { id: 'cnd_m', result: true, notEvaluated: undefined },
    ]);
    expect(explained.problems.map((problem) => [problem.code, problem.parameter ?? problem.condition])).toEqual([
      ['weights_not_100', 'cnd_s'], ['no_rules', 'cnd_empty'], ['unknown_condition', 'on'],
    ]);
  });
});

describe('the cost of a fetch\'s evaluation (section 9.4)', () => {
  it('measures evaluate at 100 conditions with percentage rules (logged, not asserted)', () => {
    const conditions = Array.from({ length: 100 }, (_, index) => match(`cnd_${index}`, [
      { attribute: 'platform', operator: 'in', value: ['ios', 'android'] },
      { attribute: 'appVersion', operator: 'versionGte', value: '1.0.0' },
      { attribute: 'percentage', operator: 'lt', value: 5000, unit: 'installation' },
    ]));
    const parameters = Array.from({ length: 500 }, (_, index) => param(`p${index}`, { type: 'number', default: 0, conditional: [{ condition: `cnd_${index % 100}`, value: 1 }] }));
    const compiled = compileTemplate(template(parameters, conditions));
    const ids = installationIds(20_000);
    const contexts = ids.map((installationId) => parseContext({ installationId, platform: 'ios', app: { version: '1.5.0' } }).context);
    for (const context of contexts.slice(0, 1000)) compiled.evaluate(context, NOW);
    const durations: number[] = [];
    const started = performance.now();
    for (const context of contexts) {
      const at = performance.now();
      compiled.evaluate(context, NOW);
      durations.push(performance.now() - at);
    }
    const perFetch = ((performance.now() - started) * 1000) / contexts.length;
    durations.sort((a, b) => a - b);
    const p95 = durations[Math.floor(durations.length * 0.95)]! * 1000;
    const resolveStarted = performance.now();
    for (const context of contexts.slice(0, 2000)) compiled.resolve(compiled.evaluate(context, NOW));
    const withResolve = ((performance.now() - resolveStarted) * 1000) / 2000;
    console.log(`evaluate, 100 conditions with a percentage rule each: ${perFetch.toFixed(1)} µs a fetch on average, p95 ${p95.toFixed(1)} µs; with resolve of 500 parameters: ${withResolve.toFixed(1)} µs`);
    expect(perFetch).toBeGreaterThan(0);
  });
});
