/**
 * CSV writing and the flattening rules FR-114 leaves to the technical specification.
 *
 * The rules, in full:
 *
 *  1. One row per submission, oldest first. Fixed leading columns:
 *     `submission_id`, `submitted_at` (ISO 8601 UTC), `form_version`, `observed_ip`.
 *  2. One column per question, across every form version present in the export.
 *     The header is `<label> (<questionId>)`; the ID makes headers unique even when
 *     two versions reuse a label, and keeps a column traceable after a rename.
 *     Columns are ordered by the authored order of the newest version that contains
 *     the question; questions only present in older versions follow.
 *  3. Single-select answers hold the option label. Multi-select answers hold the
 *     option labels joined by `; `. An option that no longer exists in the version
 *     the answer belongs to holds its raw option ID.
 *  4. Free-text and email answers hold the raw value.
 *  5. Screenshot answers hold the stable authenticated asset URLs joined by `; `.
 *  6. `clientContext` is flattened to `context.<path>` columns. Nested objects use
 *     dots, arrays use zero-based indices, and a null or scalar at the root becomes a
 *     single `context` column.
 *  7. An unanswered question is an empty cell, indistinguishable from an empty
 *     answer, which cannot occur because empty answers are rejected at submission.
 *  8. RFC 4180 quoting, CRLF row separators, and a UTF-8 byte-order mark so
 *     spreadsheet software reads accents correctly.
 */

export const CSV_BOM = '﻿';

/** RFC 4180: quote when the value holds a comma, quote, CR or LF; double inner quotes. */
export function csvCell(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  if (/[",\r\n]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
  return value;
}

export function csvRow(cells: readonly (string | null | undefined)[]): string {
  return cells.map(csvCell).join(',');
}

export function toCsv(headers: readonly string[], rows: readonly (readonly (string | null | undefined)[])[]): string {
  return CSV_BOM + [csvRow(headers), ...rows.map(csvRow)].join('\r\n') + '\r\n';
}

/**
 * Flattens an arbitrary JSON value into dotted paths (rule 6).
 *
 * An empty object or empty array yields no columns at all, which is the honest
 * representation: there is nothing to report.
 */
export function flattenJson(value: unknown, prefix = ''): Record<string, string> {
  if (value === undefined) return {};
  if (value === null) return prefix ? { [prefix]: '' } : {};
  if (typeof value !== 'object') return { [prefix || 'context']: String(value) };

  const out: Record<string, string> = {};
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      Object.assign(out, flattenJson(entry, prefix ? `${prefix}.${index}` : String(index)));
    });
    return out;
  }

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    Object.assign(out, flattenJson(entry, prefix ? `${prefix}.${key}` : key));
  }
  return out;
}
