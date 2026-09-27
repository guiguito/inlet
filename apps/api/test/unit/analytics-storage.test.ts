import { describe, expect, it } from 'vitest';
import { planRetention, type EventWeek } from '../../src/services/analytics-retention.js';
import { bindingLimit, capForDays, diskText, keptDays, recommendations } from '../../src/services/analytics-storage.js';
import { buildAnalyticsSlackMessage, durationText, type AnalyticsSlackMessageInput } from '../../src/services/analytics-slack-message.js';

/**
 * The pure parts of piece 9: AN-167's recommendations with the PRD's own examples (5.9, 12
 * "Storage and data health", 9.5), AN-164's retention plan, and the 8.2 Slack message.
 */

const DEFAULTS = { maxAgeDays: 395, maxEvents: 500_000_000, latenessDays: 30 };
const BOUND = 10_000_000_000;

describe('AN-167 recommendations', () => {
  it('pins the PRD: at 10,000,000 a day, a 500 million cap keeps between 43 and 50 days; 395 days need about 4.1 billion events and 205 GB', () => {
    const sentences = recommendations({ perDay: 10_000_000, bytesPerEvent: 50, settings: DEFAULTS, maxEventsBound: BOUND });
    expect(sentences[0]).toBe('At 10,000,000 events a day, your cap of 500 million events keeps between 43 and 50 days.');
    expect(sentences).toContain('Keeping 395 days needs a cap of about 4.1 billion events and about 205 GB.');
    expect(sentences).toContain('Keeping 30 days needs a cap of about 440 million events and about 22 GB.');
    expect(sentences).toContain('Keeping 90 days needs a cap of about 1 billion events and about 50 GB.');
    // Neither below two weeks nor fewer days than the lateness window.
    expect(sentences.join(' ')).not.toContain('cannot be honoured');
    expect(sentences.join(' ')).not.toContain('refused');
    expect(keptDays(DEFAULTS, 10_000_000)).toEqual({ min: 43, max: 50 });
    expect(bindingLimit(DEFAULTS, 10_000_000)).toBe('maxEvents');
  });

  it('pins the PRD: a 200 million cap keeps between 13 and 20 days, and with 30 days of lateness later events are refused', () => {
    const settings = { ...DEFAULTS, maxEvents: 200_000_000 };
    const sentences = recommendations({ perDay: 10_000_000, bytesPerEvent: 50, settings, maxEventsBound: BOUND });
    expect(sentences[0]).toBe('At 10,000,000 events a day, your cap of 200 million events keeps between 13 and 20 days.');
    expect(sentences).toContain(
      'The cap keeps as few as 13 days, fewer than your lateness window of 30 days, so events that arrive later than the days kept are refused.',
    );
    expect(keptDays(settings, 10_000_000)).toEqual({ min: 13, max: 20 });
  });

  it('says a cap below two weeks of volume cannot be honoured', () => {
    const sentences = recommendations({ perDay: 10_000_000, bytesPerEvent: 50, settings: { ...DEFAULTS, maxEvents: 100_000_000 }, maxEventsBound: BOUND });
    expect(sentences).toContain(
      'Your cap of 100 million events is below two weeks at this volume, about 140 million events, so it cannot be honoured: the current and previous weeks are always kept.',
    );
  });

  it('says the maximum age binds first at a small volume, and that a need beyond the deployment bound needs the operator', () => {
    const sentences = recommendations({ perDay: 1_000_000, bytesPerEvent: 50, settings: DEFAULTS, maxEventsBound: BOUND });
    expect(sentences[0]).toBe('At 1,000,000 events a day, your cap of 500 million events would keep between 493 and 500 days, so your maximum age of 395 days binds first.');
    expect(bindingLimit(DEFAULTS, 1_000_000)).toBe('maxAge');
    expect(keptDays(DEFAULTS, 1_000_000)).toEqual({ min: 395, max: 402 });
    const heavy = recommendations({ perDay: 30_000_000, bytesPerEvent: 50, settings: DEFAULTS, maxEventsBound: BOUND });
    expect(heavy.find((s) => s.startsWith('Keeping 395 days'))).toContain("above this deployment's bound of 10 billion");
  });

  it('recommends nothing without volume, and leaves the disk out without bytes per event', () => {
    expect(recommendations({ perDay: 0, bytesPerEvent: null, settings: DEFAULTS, maxEventsBound: BOUND })).toHaveLength(1);
    expect(keptDays(DEFAULTS, 0)).toBeNull();
    expect(recommendations({ perDay: 10_000_000, bytesPerEvent: null, settings: DEFAULTS, maxEventsBound: BOUND })).toContain('Keeping 395 days needs a cap of about 4.1 billion events.');
    expect(capForDays(395, 10_000_000)).toBe(4_090_000_000);
    expect([diskText(205e9), diskText(1.5e9), diskText(860e6), diskText(2e12), diskText(900)]).toEqual(['205 GB', '1.5 GB', '860 MB', '2 TB', '1 KB']);
  });
});

describe('AN-164 the retention plan', () => {
  // Today is Wednesday 2026-09-23: the current week starts 09-21, the previous 09-14.
  const TODAY = '2026-09-23';
  const week = (monday: string, rows: number): EventWeek => ({ partition: `7-${monday.replaceAll('-', '')}`, week: monday, first: monday, rows, bytes: rows * 50 });
  const weeks = [week('2026-08-24', 100), week('2026-08-31', 100), week('2026-09-07', 100), week('2026-09-14', 100), week('2026-09-21', 100)];

  it('drops whole weeks past the maximum age, keeping a week beyond it', () => {
    // 30 days back is 08-24, a Monday: its week ends 08-30, within the age, so it stays.
    expect(planRetention(weeks, { maxAgeDays: 30, maxEvents: 1_000 }, null, TODAY).drops).toEqual([]);
    // 23 days back is 08-31: the week of 08-24 ended before it and goes.
    const plan = planRetention(weeks, { maxAgeDays: 23, maxEvents: 1_000 }, null, TODAY);
    expect(plan.drops.map((w) => [w.week, w.reason])).toEqual([['2026-08-24', 'age']]);
    expect(plan).toMatchObject({ keptFrom: '2026-08-31', removedByCap: 0, eventsKept: 400, exceeded: false });
  });

  it('drops the oldest weeks until under the cap, never the current or previous week', () => {
    const plan = planRetention(weeks, { maxAgeDays: 395, maxEvents: 250 }, null, TODAY);
    expect(plan.drops.map((w) => [w.week, w.reason])).toEqual([['2026-08-24', 'cap'], ['2026-08-31', 'cap'], ['2026-09-07', 'cap']]);
    expect(plan).toMatchObject({ keptFrom: '2026-09-14', removedByCap: 300, eventsKept: 200, exceeded: false });
    const over = planRetention(weeks, { maxAgeDays: 395, maxEvents: 150 }, null, TODAY);
    expect(over.drops).toHaveLength(3);
    expect(over).toMatchObject({ eventsKept: 200, exceeded: true, keptFrom: '2026-09-14' });
  });

  it('drops a week before kept_from again, as when a racing insert recreated it, without counting it for the cap', () => {
    const plan = planRetention(weeks, { maxAgeDays: 395, maxEvents: 1_000 }, '2026-09-07', TODAY);
    expect(plan.drops.map((w) => [w.week, w.reason])).toEqual([['2026-08-24', 'floor'], ['2026-08-31', 'floor']]);
    expect(plan).toMatchObject({ keptFrom: '2026-09-07', removedByCap: 0 });
  });
});

describe('8.2 the analytics Slack message', () => {
  const settings = { messageTitle: null, channel: null, username: null, iconEmoji: null };
  const base = (over: Partial<AnalyticsSlackMessageInput>): AnalyticsSlackMessageInput => ({
    databaseName: 'Checkout app',
    storageUrl: 'http://inlet.test/analytics-databases/adb_1?tab=settings&panel=storage',
    incident: { kind: 'rate_limited', openedAt: new Date('2026-09-27T09:00:00Z'), resolvedAt: null, figures: { events: 12_480 } },
    resolution: false,
    settings,
    ...over,
  });
  const text = (input: AnalyticsSlackMessageInput) => (buildAnalyticsSlackMessage(input).blocks[0] as { text: { text: string } }).text.text;

  it('states each kind in the PRD’s words, with its figures and a link to the Storage panel', () => {
    const rate = buildAnalyticsSlackMessage(base({}));
    expect(rate.text).toBe('Analytics data health');
    expect(text(base({}))).toContain('Checkout app is rate limited: 12,480 events are refused in the last hour.');
    expect(text(base({}))).toContain('Opened 2026-09-27 09:00 UTC.');
    expect(text(base({}))).toContain('<http://inlet.test/analytics-databases/adb_1?tab=settings&panel=storage|Open in Inlet>');
    expect(text(base({ incident: { kind: 'storage_cap_reached', openedAt: new Date(), resolvedAt: null, figures: { week: '2026-09-01', eventsKept: 500_000_000 } } }))).toContain(
      'Checkout app is at its storage cap: the week of September 1 is removed early, and 500,000,000 events are kept.',
    );
    expect(text(base({ incident: { kind: 'event_name_limit', openedAt: new Date(), resolvedAt: null, figures: { names: 500 } } }))).toContain(
      'Checkout app refuses new event names: it holds 500.',
    );
  });

  it('says how long a resolved incident lasted and how many events it affected', () => {
    const input = base({ resolution: true, incident: { kind: 'rate_limited', openedAt: new Date('2026-09-27T09:00:00Z'), resolvedAt: new Date('2026-09-27T12:00:00Z'), figures: { events: 1_200, affected: 12_480 } } });
    expect(text(input)).toContain('Resolved. It lasted 3 hours and affected 12,480 events.');
    expect([durationText(90_000), durationText(3_600_000), durationText(3 * 86_400_000)]).toEqual(['2 minutes', '1 hour', '3 days']);
  });

  it('uses the configured heading and escapes the database name', () => {
    const message = buildAnalyticsSlackMessage(base({ databaseName: 'A <b> & c', settings: { ...settings, messageTitle: 'Ops', channel: '#ops' } }));
    expect(message.text).toBe('Ops');
    expect(message.channel).toBe('#ops');
    expect(JSON.stringify(message.blocks)).toContain('A &lt;b&gt; &amp; c');
  });
});
