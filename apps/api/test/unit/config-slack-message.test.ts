import { describe, expect, it } from 'vitest';
import { changeSummary } from '@inlet/shared';
import { buildConfigSlackMessage, changeLine, type ConfigSlackMessageInput } from '../../src/services/config-slack-message.js';
import { rollbackNote } from '../../src/services/config-publish.js';
import { match, param, template } from './config-fixtures.js';

/** The three config Slack messages (Remote Config RC-080 to RC-082, section 8.2). */

const settings = { messageTitle: null, channel: null, username: null, iconEmoji: null };
const url = 'https://inlet.example/config-databases/cfg_1?tab=history';
const input = (fields: Partial<ConfigSlackMessageInput>): ConfigSlackMessageInput => ({
  kind: 'publish', databaseName: 'Mobile app config', historyUrl: url, version: 15, rolledBackFrom: null, actor: 'Guilhem', note: null, summary: null, settings, ...fields,
});
const textOf = (fields: Partial<ConfigSlackMessageInput>) => (buildConfigSlackMessage(input(fields)).blocks[0] as { text: { text: string } }).text.text;

describe('config Slack messages', () => {
  it('renders a publish as section 8.2 does', () => {
    const summary = changeSummary(template([param('old')]), template([param('new_checkout'), param('checkout_limits')], [match('cnd_a', [])]));
    expect(textOf({ note: '10% rollout of the new checkout.', summary })).toBe(
      [
        '*Config published*',
        'Mobile app config: version 15 published by Guilhem. 10% rollout of the new checkout.',
        'Changed: new_checkout, checkout_limits, old. Conditions: 1 added.',
        `<${url}|Open in Inlet>`,
      ].join('\n'),
    );
    expect(buildConfigSlackMessage(input({})).text).toBe('Config published');
  });

  it('names ten keys then how many more, and counts conditions added, changed and removed, leaving empty parts out', () => {
    const before = template([], [match('cnd_a', []), match('cnd_b', []), match('cnd_c', [])]);
    const after = template(Array.from({ length: 13 }, (_, i) => param(`k${i}`)), [{ ...match('cnd_a', []), name: 'Renamed' }, match('cnd_d', [])]);
    expect(changeLine(changeSummary(before, after))).toBe('Changed: k0, k1, k2, k3, k4, k5, k6, k7, k8, k9 and 3 more. Conditions: 1 added, 1 changed, 2 removed.');
    expect(changeLine(changeSummary(template([param('a')]), template([param('a', { default: true })])))).toBe('Changed: a.');
    expect(changeLine(changeSummary(template([], [match('cnd_a', [])]), template([], [])))).toBe('Conditions: 1 removed.');
    expect(changeLine(changeSummary(template([param('a')]), template([param('a')])))).toBeNull();
    expect(changeLine(null)).toBeNull();
  });

  it('renders a rollback without repeating the recorded prefix, and an unpublish without changes', () => {
    const summary = changeSummary(template([param('a')]), template([param('a', { default: true })]));
    expect(textOf({ kind: 'rollback', version: 16, rolledBackFrom: 12, note: rollbackNote(12, 'Bad copy.'), summary }).split('\n')).toEqual([
      '*Config rolled back*',
      'Mobile app config: version 16 published by Guilhem, rolling back to version 12. Bad copy.',
      'Changed: a.',
      `<${url}|Open in Inlet>`,
    ]);
    expect(textOf({ kind: 'rollback', version: 16, rolledBackFrom: 12, note: rollbackNote(12) }).split('\n')[1]).toBe('Mobile app config: version 16 published by Guilhem, rolling back to version 12.');
    expect(textOf({ kind: 'unpublish', version: null, summary }).split('\n')).toEqual([
      '*Config unpublished*',
      'Mobile app config: unpublished by Guilhem: apps use their in-app defaults from their next fetch.',
      `<${url}|Open in Inlet>`,
    ]);
  });

  it('escapes the name, actor, note and keys, keeps the operator heading as written, and carries the settings', () => {
    const summary = changeSummary(null, template([param('a<b>')]));
    const message = buildConfigSlackMessage(input({
      databaseName: 'A & <B>', actor: '<@U123>', note: 'Ping <!channel>', summary,
      settings: { messageTitle: '*Releases*', channel: '#config', username: 'Inlet', iconEmoji: ':gear:' },
    }));
    const text = (message.blocks[0] as { text: { text: string } }).text.text;
    expect(text).toContain('**Releases**');
    expect(text).toContain('A &amp; &lt;B&gt;: version 15 published by &lt;@U123&gt;. Ping &lt;!channel&gt;');
    expect(text).toContain('Changed: a&lt;b&gt;.');
    expect(message).toMatchObject({ channel: '#config', username: 'Inlet', icon_emoji: ':gear:' });
  });

  it('shortens only the note when escaping would pass Slack’s 3,000-character section, and never lets a mention through', () => {
    const summary = changeSummary(null, template(Array.from({ length: 12 }, (_, i) => param(`${String.fromCharCode(97 + i)}${'k'.repeat(127)}`))));
    const text = textOf({ databaseName: '&'.repeat(200), actor: '<'.repeat(120), note: '<!channel>'.repeat(50), summary });
    expect(text.length).toBeLessThanOrEqual(3000);
    expect(text).not.toMatch(/<(?!https:)/);
    expect(text).toContain('and 2 more.');
    expect(text.split('\n')[1]).toMatch(/…$/);
    expect(text.endsWith(`<${url}|Open in Inlet>`)).toBe(true);
    // A short note is left whole.
    expect(textOf({ note: 'Short.' })).toContain('by Guilhem. Short.');
  });
});
