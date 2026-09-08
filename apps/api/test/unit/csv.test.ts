import { describe, expect, it } from 'vitest';
import { csvCell, flattenJson, toCsv } from '../../src/lib/csv.js';

/** The CSV flattening rules FR-114 delegates to the technical specification. */
describe('csvCell', () => {
  it('leaves a plain value alone', () => {
    expect(csvCell('Payments')).toBe('Payments');
  });

  it('quotes commas, quotes and newlines, doubling inner quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('one\ntwo')).toBe('"one\ntwo"');
    expect(csvCell('one\r\ntwo')).toBe('"one\r\ntwo"');
  });

  it('renders an absent value as an empty cell', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell('')).toBe('');
  });
});

describe('toCsv', () => {
  it('writes a byte-order mark, CRLF rows and a trailing newline', () => {
    const csv = toCsv(['a', 'b'], [['1', '2']]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toBe('﻿a,b\r\n1,2\r\n');
  });

  it('writes only a header row when there is nothing to export', () => {
    expect(toCsv(['a'], [])).toBe('﻿a\r\n');
  });
});

describe('flattenJson', () => {
  it('uses dots for nested objects and indices for arrays', () => {
    expect(
      flattenJson({ app: { version: '4.1', tags: ['a', 'b'] }, ok: true }, 'context'),
    ).toEqual({
      'context.app.version': '4.1',
      'context.app.tags.0': 'a',
      'context.app.tags.1': 'b',
      'context.ok': 'true',
    });
  });

  it('produces no columns for an absent, empty or object-free context', () => {
    expect(flattenJson(undefined, 'context')).toEqual({});
    expect(flattenJson({}, 'context')).toEqual({});
    expect(flattenJson([], 'context')).toEqual({});
  });

  it('renders an explicit null as an empty cell under its own path', () => {
    expect(flattenJson({ a: null }, 'context')).toEqual({ 'context.a': '' });
  });

  it('puts a scalar context under the bare prefix', () => {
    expect(flattenJson('just a string', 'context')).toEqual({ context: 'just a string' });
    expect(flattenJson(42, 'context')).toEqual({ context: '42' });
  });
});
