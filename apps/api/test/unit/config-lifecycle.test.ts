import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  changedParameterKeys,
  changeSummary,
  diffTemplates,
  eraseIdFromTemplate,
  exportDefaultsJson,
  exportDefaultsTypeScript,
  publishWarnings,
  templatesEqual,
  type ConfigCondition,
} from '@inlet/shared';
import { checkConfigPublish, checkConfigSave } from '@inlet/shared/config-check';
import { match, param, split, template } from './config-fixtures.js';

/** Remote Config PRD RC-017, RC-052, RC-054, RC-057, RC-063, RC-081 and RC-100. */

const rule = { attribute: 'platform' as const, operator: 'exists' as const };
const base = template(
  [
    param('new_checkout', { live: true, conditional: [{ condition: 'cnd_a', value: true }] }),
    param('limit', { type: 'number', default: 10 }),
    param('copy', { type: 'string', default: 'hi', conditional: [{ condition: 'cnd_b', value: 'b' }, { condition: 'cnd_a', value: 'a' }] }),
  ],
  [match('cnd_a', [rule], 'A'), match('cnd_b', [rule], 'B'), match('cnd_c', [rule], 'C')],
);

describe('equality (RC-052, RC-054)', () => {
  it('ignores the order of parameters and of a parameter\'s conditional values', () => {
    const reordered = { ...base, parameters: [...base.parameters].reverse() };
    expect(templatesEqual(base, reordered)).toBe(true);
    const conditional = structuredClone(base);
    conditional.parameters[2]!.conditional.reverse();
    expect(templatesEqual(base, conditional)).toBe(true);
    expect(templatesEqual(base, structuredClone(base))).toBe(true);
  });

  it('counts a condition reorder, and any change of value, as a change', () => {
    expect(templatesEqual(base, { ...base, conditions: [...base.conditions].reverse() })).toBe(false);
    const changed = structuredClone(base);
    changed.parameters[1]!.default = 11;
    expect(templatesEqual(base, changed)).toBe(false);
  });
});

describe('difference and change summary (RC-052, RC-057, RC-081)', () => {
  it('reports a parameter reorder as nothing, and a condition reorder as reordered only', () => {
    expect(diffTemplates(base, { ...base, parameters: [...base.parameters].reverse() })).toEqual({ parameters: [], conditions: [], conditionsReordered: false });
    const reordered = { ...base, conditions: [base.conditions[1]!, base.conditions[0]!, base.conditions[2]!] };
    expect(diffTemplates(base, reordered)).toEqual({ parameters: [], conditions: [], conditionsReordered: true });
  });

  it('sees a swap of the conditions both hold through an addition and a removal', () => {
    const [a, b, c] = base.conditions as [ConfigCondition, ConfigCondition, ConfigCondition];
    const diff = diffTemplates(base, { ...base, conditions: [c, match('cnd_new', [rule], 'New'), a] });
    expect(diff.conditionsReordered).toBe(true);
    expect(diff.conditions.map(({ id, change }) => [id, change])).toEqual([['cnd_new', 'added'], ['cnd_b', 'removed']]);
    expect(changeSummary(base, { ...base, conditions: [c, a] }).conditions).toEqual({ added: [], changed: [], removed: ['cnd_b'], reordered: true });
    expect(b.id).toBe('cnd_b');
  });

  it('serializes canonically: keys sorted at every level, array order kept', () => {
    expect(canonicalJson({ b: [{ d: 1, c: 2 }, 3], a: { z: 1, y: [3, { x: null }] }, u: undefined })).toBe('{"a":{"y":[3,{"x":null}],"z":1},"b":[{"c":2,"d":1},3]}');
    expect(canonicalJson(JSON.parse('{"__proto__": {"b": 1, "a": 2}}'))).toBe('{"__proto__":{"a":2,"b":1}}');
  });

  it('ignores additions and removals when deciding whether the order changed', () => {
    const next = { ...base, conditions: [base.conditions[0]!, match('cnd_new', [rule], 'New'), base.conditions[2]!] };
    const diff = diffTemplates(base, next);
    expect(diff.conditionsReordered).toBe(false);
    expect(diff.conditions.map(({ id, change }) => [id, change])).toEqual([['cnd_new', 'added'], ['cnd_b', 'removed']]);
  });

  it('lists added, changed and removed parameters and conditions with before and after', () => {
    const next = structuredClone(base);
    next.parameters[1]!.default = 20;
    next.parameters = next.parameters.filter((parameter) => parameter.key !== 'copy');
    next.parameters.push(param('fresh'));
    next.conditions[2]!.name = 'C renamed';
    next.conditions.push(match('cnd_d', [rule], 'D'));
    const diff = diffTemplates(base, next);
    expect(diff.parameters.map(({ key, change }) => [key, change])).toEqual([['limit', 'changed'], ['fresh', 'added'], ['copy', 'removed']]);
    expect(diff.parameters[0]).toMatchObject({ before: { default: 10 }, after: { default: 20 } });
    expect(diff.parameters[2]!.after).toBeUndefined();
    expect(diff.conditions.map(({ id, change }) => [id, change])).toEqual([['cnd_c', 'changed'], ['cnd_d', 'added']]);

    const summary = changeSummary(base, next);
    expect(summary).toEqual({
      parameters: { added: ['fresh'], changed: ['limit'], removed: ['copy'] },
      conditions: { added: ['cnd_d'], changed: ['cnd_c'], removed: [], reordered: false },
      counts: { parametersAdded: 1, parametersChanged: 1, parametersRemoved: 1, conditionsAdded: 1, conditionsChanged: 1, conditionsRemoved: 0 },
    });
    expect(changedParameterKeys(summary)).toEqual(['fresh', 'limit', 'copy']);
  });

  it('summarises a first version as everything added', () => {
    const summary = changeSummary(null, base);
    expect(summary.parameters.added).toEqual(['new_checkout', 'limit', 'copy']);
    expect(summary.conditions).toEqual({ added: ['cnd_a', 'cnd_b', 'cnd_c'], changed: [], removed: [], reordered: false });
  });
});

describe('publish warnings (RC-017)', () => {
  it('warns for a type change and a removal, never refusing', async () => {
    const next = structuredClone(base);
    next.parameters[1] = param('limit', { type: 'string', default: '10' });
    next.parameters = next.parameters.filter((parameter) => parameter.key !== 'copy');
    expect(publishWarnings(next, base)).toEqual([
      { parameter: 'limit', code: 'parameter_type_changed', message: 'Apps that read `limit` as a number will use their in-app default.' },
      { parameter: 'copy', code: 'parameter_removed', message: 'Apps that read `copy` will use their in-app default.' },
    ]);
    expect(publishWarnings(next, null)).toEqual([]);
    expect((await checkConfigPublish(next)).ok).toBe(true);
  });
});

describe('defaults export (RC-063)', () => {
  const exported = template([
    param('new_checkout', { description: 'The redesigned checkout */ with a */ inside' }),
    param('a.b-c', { type: 'string', default: 'x "quoted"\n' }),
    param('limit', { type: 'number', default: 3.5, description: 'Line one\nline two' }),
    param('paywall', { type: 'json', default: { headline: 'Go Pro', plans: ['monthly', 'annual'], nested: { 'odd key': null } } }),
  ]);

  const awkward = template([
    param('blob', { type: 'json', default: JSON.parse('{"__proto__": {"polluted": true}, "list": [{"__proto__": 1}, "__proto__"], "text": "</script>`${x}`\\u2028\\"__proto__\\": 1"}') }),
    param('constructor', { type: 'string', default: 'c', description: 'ends in *' }),
    param('q', { type: 'string', default: 'x', description: '*/ alert(1) /*\r\n */ x' }),
  ]);

  it('writes a key named __proto__ inside a json value as an own key, and no description can close its comment', () => {
    const source = exportDefaultsTypeScript(awkward);
    const literal = source.slice(source.indexOf('export const configDefaults: ConfigDefaults = ') + 'export const configDefaults: ConfigDefaults = '.length).trim().replace(/;$/, '');
    const read = new Function(`return ${literal}`)() as Record<string, unknown>;
    expect(read).toEqual(exportDefaultsJson(awkward));
    const blob = read.blob as Record<string, unknown>;
    expect(Object.hasOwn(blob, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(blob)).toBe(Object.prototype);
    expect(Object.hasOwn((blob.list as object[])[0]!, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(source.match(/\*\//g)?.length).toBe(4);
  });

  it('gives the defaults as JSON in the template\'s order', () => {
    expect(exportDefaultsJson(exported)).toEqual({ new_checkout: false, 'a.b-c': 'x "quoted"\n', limit: 3.5, paywall: exported.parameters[3]!.default });
  });

  it('writes deterministic TypeScript that quotes keys where needed and carries descriptions', () => {
    const source = exportDefaultsTypeScript(exported);
    expect(exportDefaultsTypeScript(structuredClone(exported))).toBe(source);
    expect(source).toContain('"a.b-c": string;');
    expect(source).toContain('  new_checkout: boolean;');
    expect(source).toContain('/** The redesigned checkout *\\/ with a *\\/ inside */');
    expect(source).toContain('   * line two');
    expect(source).toContain('export type InletJson =');
    expect(source).toContain('paywall: InletJson;');
    expect(exportDefaultsTypeScript(template([param('flag')]))).not.toContain('InletJson');
  });

  it('compiles with the TypeScript compiler, and its values read back as the defaults', () => {
    const directory = mkdtempSync(join(tmpdir(), 'inlet-defaults-'));
    try {
      const source = `${exportDefaultsTypeScript(exported)}
const checkout: boolean = configDefaults.new_checkout;
const limit: number = configDefaults.limit;
const quoted: string = configDefaults['a.b-c'];
export const read = [checkout, limit, quoted, configDefaults.paywall];
`;
      const tsc = resolve(import.meta.dirname, '../../../../node_modules/.bin/tsc');
      // Run from the temporary directory, which holds no tsconfig.json for tsc to refuse to ignore.
      const compile = (name: string, text: string): string => {
        writeFileSync(join(directory, name), text);
        try {
          execFileSync(tsc, ['--noEmit', '--strict', '--target', 'es2022', '--module', 'esnext', '--skipLibCheck', name], { cwd: directory, stdio: 'pipe' });
          return '';
        } catch (error) {
          return String((error as { stdout?: Buffer }).stdout ?? error);
        }
      };
      expect(compile('defaults.ts', source)).toBe('');
      expect(compile('broken.ts', `${exportDefaultsTypeScript(exported)}\nexport const wrong: string = configDefaults.limit;\n`)).toContain('TS2322');
      expect(compile('awkward.ts', exportDefaultsTypeScript(awkward))).toBe('');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('erasure rewrite (RC-100)', () => {
  const id = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
  const erasable = template([], [
    match('cnd_eq', [{ attribute: 'userId', operator: 'equals', value: 'u-1' }, { attribute: 'userId', operator: 'notEquals', value: 'u-1' }]),
    match('cnd_list', [{ attribute: 'userId', operator: 'in', value: ['u-1', 'u-2'] }, { attribute: 'userId', operator: 'notIn', value: ['u-3'] }]),
    split('cnd_s', [['a', 10000]], { rules: [{ attribute: 'installationId', operator: 'notIn', value: [id, 'b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'] }] }),
    match('cnd_inst', [{ attribute: 'installationId', operator: 'equals', value: id }, { attribute: 'attributes.userId', operator: 'equals', value: 'u-1' }]),
  ]);

  it('turns equals into in [], notEquals into notIn [], removes the ID from lists and counts the rules', () => {
    const { template: rewritten, rules } = eraseIdFromTemplate(erasable, 'userId', 'u-1');
    expect(rules).toBe(3);
    expect(rewritten.conditions[0]!.rules).toEqual([{ attribute: 'userId', operator: 'in', value: [] }, { attribute: 'userId', operator: 'notIn', value: [] }]);
    expect(rewritten.conditions[1]!.rules).toEqual([{ attribute: 'userId', operator: 'in', value: ['u-2'] }, { attribute: 'userId', operator: 'notIn', value: ['u-3'] }]);
    // A custom attribute is the team's own, not the user ID: left alone.
    expect(rewritten.conditions[3]!.rules[1]).toEqual({ attribute: 'attributes.userId', operator: 'equals', value: 'u-1' });
    expect(erasable.conditions[0]!.rules[0]!.operator).toBe('equals');
    expect(checkConfigSave(rewritten).ok).toBe(true);
  });

  it('compares installation IDs normalised, in split populations too', async () => {
    const { template: rewritten, rules } = eraseIdFromTemplate(erasable, 'installationId', 'A1B2C3D4E5F64A7B8C9D0E1F2A3B4C5D');
    expect(rules).toBe(2);
    expect(rewritten.conditions[2]!.rules[0]!.value).toEqual(['b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d']);
    expect(rewritten.conditions[3]!.rules[0]).toEqual({ attribute: 'installationId', operator: 'in', value: [] });
    expect((await checkConfigPublish({ ...rewritten, conditions: rewritten.conditions.filter((condition) => condition.kind === 'match') })).ok).toBe(true);
  });

  it('leaves a template naming nothing unchanged', () => {
    const result = eraseIdFromTemplate(erasable, 'userId', 'nobody');
    expect(result).toEqual({ template: erasable, rules: 0 });
    expect(eraseIdFromTemplate(erasable, 'installationId', 'not-a-uuid').rules).toBe(0);
  });
});
