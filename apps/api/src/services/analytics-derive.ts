import { createHmac } from 'node:crypto';
import { ANALYTICS_DEFAULTS } from '@inlet/shared/analytics-core';
import { apiError } from '../lib/errors.js';

/**
 * The pure arithmetic of ingest (UX Analytics AN-014, AN-017, AN-025, AN-030, AN-032,
 * Appendix B.1): clock correction, local days and install ages in the reporting timezone,
 * and the derived installation IDs. No state and no I/O, so each rule has a unit test.
 *
 * Periods are computed here with ICU (`Intl`) rather than in ClickHouse, which refuses a
 * timezone argument that is not a constant (DECISIONS 31.3.5): every event of a batch may
 * belong to a different database, and so to a different zone.
 */

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/**
 * AN-014: the effective time of an event. When the batch's `sentAt` differs from the
 * received time by more than 60 seconds, every event's timestamp moves by that difference
 * rounded to the whole minute; an effective time more than five minutes after the received
 * time becomes the received time. Either is reported as `clock_corrected`.
 */
export function effectiveTime(timestampMs: number, sentAtMs: number, receivedMs: number): { effectiveMs: number; corrected: boolean } {
  const skew = receivedMs - sentAtMs;
  let effectiveMs = timestampMs;
  let corrected = false;
  if (Math.abs(skew) > ANALYTICS_DEFAULTS.clockCorrectionThresholdMs) {
    // Half a minute rounds away from zero, so a clock 90 s ahead and one 90 s behind move by
    // the same two minutes (Math.round alone would round -1.5 to -1).
    effectiveMs += Math.sign(skew) * Math.round(Math.abs(skew) / MINUTE_MS) * MINUTE_MS;
    corrected = true;
  }
  if (effectiveMs > receivedMs + ANALYTICS_DEFAULTS.clockFutureClampMs) {
    effectiveMs = receivedMs;
    corrected = true;
  }
  return { effectiveMs, corrected };
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();

/** AN-030: the calendar day containing `ms` in `timezone`, as `YYYY-MM-DD`. */
export function localDay(ms: number, timezone: string): string {
  let format = dayFormats.get(timezone);
  if (!format) {
    // en-CA formats a date as YYYY-MM-DD; the parts are read anyway, so no locale quirk matters.
    format = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormats.set(timezone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(ms).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Days since 1970-01-01 of a calendar date: the date's own count, with no timezone left in it. */
function dayNumber(day: string): number {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return Math.round(Date.UTC(year, month - 1, date) / DAY_MS);
}

/** The ISO week containing `day`, counted from the week of 1970-01-01. 1970-01-01 was a Thursday. */
function weekNumber(day: string): number {
  // Monday is day 4 of the epoch's week (Thursday = 0), so shifting by 3 makes weeks start on Monday.
  return Math.floor((dayNumber(day) + 3) / 7);
}

function monthNumber(day: string): number {
  const [year, month] = day.split('-').map(Number) as [number, number];
  return year * 12 + (month - 1);
}

export type InstallAges = { days: number; weeks: number; months: number };

/**
 * AN-032, Appendix B.1: the number of days, ISO weeks and calendar months between the
 * period containing the install time and the period containing the event, in the reporting
 * timezone; zero for an event whose effective time precedes the install time. Bounded to
 * the event store's UInt16.
 */
export function installAges(installMs: number, eventMs: number, timezone: string): InstallAges {
  if (eventMs < installMs) return { days: 0, weeks: 0, months: 0 };
  const from = localDay(installMs, timezone);
  const to = localDay(eventMs, timezone);
  const bound = (value: number) => Math.min(65_535, Math.max(0, value));
  return {
    days: bound(dayNumber(to) - dayNumber(from)),
    weeks: bound(weekNumber(to) - weekNumber(from)),
    months: bound(monthNumber(to) - monthNumber(from)),
  };
}

/** A UUID (RFC 9562 version 8, "custom") from the first 16 bytes of an HMAC-SHA256. */
function uuidFromHmac(secret: string, message: string): string {
  const bytes = createHmac('sha256', secret).update(message).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * AN-017: the server installation of a user ID, under the database's installation secret:
 * the same user always maps to the same installation in one database and to unrelated ones
 * across databases, and nobody without the secret can compute it from the user ID. The
 * prefix keeps it apart from the test installation's derivation, whatever the user ID.
 */
export function serverInstallationId(secret: string, userId: string): string {
  return uuidFromHmac(secret, `user:${userId}`);
}

/** AN-025: the test installation, derived the same way from a fixed label. */
export function testInstallationId(secret: string): string {
  return uuidFromHmac(secret, 'test-installation');
}

/** The event store's `event_name_id` is a UInt32, which 2^32 would silently wrap to 0, "any event". */
export const MAX_EVENT_NAME_ID = 4_294_967_295;

/**
 * A catalog ID as the event store carries it. An ID the column cannot hold refuses the batch
 * with a logged server error rather than store events under another name's ID.
 */
export function eventNameIdFor(id: number): number {
  if (!Number.isInteger(id) || id < 1 || id > MAX_EVENT_NAME_ID) {
    throw apiError('internal_error', `Event name ID ${id} does not fit the event store's 32-bit column; refusing the batch rather than storing it under another ID.`);
  }
  return id;
}

/** `YYYY-MM-DD hh:mm:ss.sss` in UTC, the text form of the event store's `DateTime64(3, 'UTC')`. */
export function eventStoreTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 23);
}
