/**
 * Diffs a Notion PRD page against its `docs/prd` mirror.
 *
 * The two are meant to be the same document, but Notion's markdown serializer is not a
 * round trip: tables come back as `<td>` cells rather than pipe rows, `~` is escaped, and a
 * bare domain is auto-linked. Those are read-time artifacts — rewriting them in Notion just
 * produces them again — so they are normalised away here rather than chased. Anything this
 * still reports is real drift.
 *
 * Usage: node scripts/prd-parity.mjs <notion-fetch.json> <docs/prd/x.md>
 */
import { readFileSync } from 'node:fs';

const normalise = (text) => {
  const out = [];
  for (let line of text.replaceAll(' ', ' ').split('\n')) {
    line = line.trimEnd();
    if (!line.trim()) continue;
    if (/^<\/?(table|tr)\b/.test(line)) continue;
    line = line.replaceAll('\\~', '~').replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1');
    const cell = /^<t[dh]>(.*)<\/t[dh]>$/.exec(line);
    if (cell) { out.push(`CELL: ${cell[1]}`); continue; }
    if (line.trimStart().startsWith('|')) {
      const parts = line.trim().replace(/^\||\|$/g, '').split('|').map((p) => p.trim());
      if (parts.every((p) => /^[-: ]*$/.test(p))) continue;
      out.push(...parts.map((p) => `CELL: ${p}`));
      continue;
    }
    out.push(line);
  }
  return out;
};

const [, , notionJson, mirrorPath] = process.argv;
// The fetch tool persists its result in two shapes depending on size: an array of content
// blocks whose `text` is itself JSON, or the bare object. Accept either, and a raw page dump.
const fetched = JSON.parse(readFileSync(notionJson, 'utf8'));
const outer = Array.isArray(fetched) ? fetched[0].text : fetched.text;
let page;
try {
  page = JSON.parse(outer).text;
} catch {
  page = outer;
}
const notion = normalise(page.split('<content>')[1].split('</content>')[0]);
// The mirror carries a title heading and a back-link to the page; the page has neither.
const mirror = normalise(readFileSync(mirrorPath, 'utf8')).filter(
  (l) => !l.startsWith('# Inlet —') && !l.startsWith('**Notion page:**'),
);

const drift = [];
for (let i = 0; i < Math.max(notion.length, mirror.length); i += 1) {
  if (notion[i] !== mirror[i]) drift.push(`  notion: ${notion[i] ?? '(none)'}\n  mirror: ${mirror[i] ?? '(none)'}`);
}
console.log(`notion ${notion.length} lines / mirror ${mirror.length} lines`);
if (drift.length === 0) {
  console.log('PARITY OK');
} else {
  console.log(`${drift.length} differing:\n${drift.slice(0, 20).join('\n\n')}`);
  process.exitCode = 1;
}