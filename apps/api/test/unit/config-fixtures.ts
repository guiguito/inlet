import { randomBytes } from 'node:crypto';
import type { ConfigCondition, ConfigParameter, ConfigRule, ConfigTemplate } from '@inlet/shared';

/** Builders for Remote Config templates in unit tests. Every builder takes what the test cares about. */

let counter = 0;
export function salt(): string {
  counter += 1;
  return `S${String(counter).padStart(15, '0')}`;
}

export function param(key: string, fields: Partial<ConfigParameter> = {}): ConfigParameter {
  return { key, type: 'boolean', live: false, default: false, conditional: [], ...fields };
}

export function match(id: string, rules: ConfigRule[], name = id): ConfigCondition {
  return { id, name, kind: 'match', salt: salt(), rules };
}

export function split(id: string, variants: Array<[string, number]>, fields: Partial<Extract<ConfigCondition, { kind: 'split' }>> = {}): ConfigCondition {
  return {
    id, name: id, kind: 'split', salt: salt(), experiment: `exp_${id}`, unit: 'installation', rules: [],
    variants: variants.map(([key, weight]) => ({ key, weight })), ...fields,
  };
}

export function template(parameters: ConfigParameter[], conditions: ConfigCondition[] = []): ConfigTemplate {
  return { parameters, conditions };
}

/** A random lower-case dashed UUID v4, fast enough for 100,000 of them. */
export function installationIds(count: number): string[] {
  const bytes = randomBytes(count * 16);
  const out: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const hex = bytes.subarray(index * 16, index * 16 + 16).toString('hex');
    out.push(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`);
  }
  return out;
}
