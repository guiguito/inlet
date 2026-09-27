import { describe, expect, it } from 'vitest';
import { loadEnv, parseOperatorLimits, parseTrustProxy } from '../../src/env.js';
import { TEST_ENV } from '../setup/config.js';

/** Section 12.6: switching providers must be configuration only. */
describe('parseTrustProxy', () => {
  it('trusts nothing by default', () => {
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
  });

  it('accepts a boolean, a hop count and a list of addresses', () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('10.0.0.0/8, 127.0.0.1')).toEqual(['10.0.0.0/8', '127.0.0.1']);
  });
});

describe('loadEnv', () => {
  it('rejects a configuration that is missing what the deployment needs', () => {
    expect(() => loadEnv({ NODE_ENV: 'production' })).toThrow(/Invalid Inlet configuration/);
  });

  it('reports every problem at once rather than one per restart', () => {
    try {
      loadEnv({ NODE_ENV: 'production' });
      throw new Error('expected a throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('INLET_DATABASE_URL');
      expect(message).toContain('INLET_SESSION_SECRET');
    }
  });

  it('refuses to disable the security rate limits outside tests (FR-088)', () => {
    expect(() =>
      loadEnv({ ...TEST_ENV, NODE_ENV: 'production', INLET_DISABLE_RATE_LIMITS: 'true' }),
    ).toThrow(/only honored when NODE_ENV=test/);
  });

  it('requires a session secret long enough to be worth signing with', () => {
    expect(() => loadEnv({ ...TEST_ENV, INLET_SESSION_SECRET: 'too-short' })).toThrow(
      /INLET_SESSION_SECRET/,
    );
  });

  it('defaults the intent lifetime and pending-upload expiry', () => {
    const env = loadEnv({
      ...TEST_ENV,
      INLET_INTENT_TTL_MINUTES: undefined,
      INLET_PENDING_UPLOAD_EXPIRY_DAYS: undefined,
    } as NodeJS.ProcessEnv);
    expect(env.INLET_INTENT_TTL_MINUTES).toBe(30);
    expect(env.INLET_PENDING_UPLOAD_EXPIRY_DAYS).toBe(1);
  });
});

/** Foundations FD-032: the analytics rows of OPERATOR_LIMITS (UX Analytics section 14). */
describe('the analytics operator limits', () => {
  it('default to section 14 of the UX Analytics PRD', () => {
    const limits = parseOperatorLimits({});
    expect(limits).toMatchObject({
      analyticsDatabasesMax: 50,
      analyticsEventNamesMax: 500,
      analyticsNewEventNamesPerHour: 50,
      analyticsParamKeysPerEvent: 100,
      analyticsCategoriesPerEvent: 10,
      analyticsMaxAgeDaysDefault: 395,
      analyticsMaxAgeDaysMin: 7,
      analyticsMaxAgeDaysMax: 760,
      analyticsMaxEventsDefault: 500_000_000,
      analyticsMaxEventsMin: 100_000,
      analyticsMaxEventsMax: 10_000_000_000,
      analyticsLatenessDaysDefault: 30,
      analyticsLatenessDaysMin: 1,
      analyticsLatenessDaysMax: 90,
      analyticsPerKeyFiveMinutes: 200_000,
      analyticsPerKeyHour: 2_000_000,
      analyticsPerInstallationFiveMinutes: 1_000,
      analyticsPerAddressPerMinute: 6_000,
      analyticsQuerySlots: 3,
      analyticsQueryTimeSeconds: 30,
      analyticsFunnelTrendTimeSeconds: 120,
      analyticsQueryThreads: 0,
      analyticsErasureFileRemovalDays: 30,
    });
  });

  it('parses values beyond 32 bits exactly', () => {
    const limits = parseOperatorLimits({ INLET_ANALYTICS_MAX_EVENTS_MAX: '40000000000', INLET_ANALYTICS_MAX_EVENTS_DEFAULT: '4100000000' });
    expect(limits.analyticsMaxEventsMax).toBe(40_000_000_000);
    expect(limits.analyticsMaxEventsDefault).toBe(4_100_000_000);
  });

  it('refuses a value outside its hard limits, naming it', () => {
    expect(() => parseOperatorLimits({ INLET_ANALYTICS_EVENT_NAMES_MAX: '5001' })).toThrow(/INLET_ANALYTICS_EVENT_NAMES_MAX: must be an integer from 10 to 5000/);
    expect(() => parseOperatorLimits({ INLET_ANALYTICS_ERASURE_BOUND_DAYS: '31' })).toThrow(/INLET_ANALYTICS_ERASURE_BOUND_DAYS/);
    expect(() => parseOperatorLimits({ INLET_ANALYTICS_QUERY_SLOTS: '1' })).toThrow(/INLET_ANALYTICS_QUERY_SLOTS/);
    expect(() => parseOperatorLimits({ INLET_ANALYTICS_DATABASES_MAX: 'many' })).toThrow(/INLET_ANALYTICS_DATABASES_MAX/);
  });

  it('keeps MIN ≤ DEFAULT ≤ MAX for each storage setting, and the lateness within the maximum age', () => {
    expect(() => parseOperatorLimits({ INLET_ANALYTICS_MAX_AGE_DAYS_DEFAULT: '800' })).toThrow(/INLET_ANALYTICS_MAX_AGE_DAYS_\*: MIN ≤ DEFAULT ≤ MAX/);
    expect(() => parseOperatorLimits({ INLET_ANALYTICS_MAX_EVENTS_MIN: '600000000' })).toThrow(/INLET_ANALYTICS_MAX_EVENTS_\*/);
    expect(() => parseOperatorLimits({ INLET_ANALYTICS_LATENESS_DAYS_MAX: '20' })).toThrow(/INLET_ANALYTICS_LATENESS_DAYS_\*/);
    expect(() => parseOperatorLimits({ INLET_ANALYTICS_MAX_AGE_DAYS_DEFAULT: '20' })).toThrow(/LATENESS_DAYS_DEFAULT: must not exceed INLET_ANALYTICS_MAX_AGE_DAYS_DEFAULT/);
    expect(parseOperatorLimits({ INLET_ANALYTICS_MAX_AGE_DAYS_DEFAULT: '30' }).analyticsMaxAgeDaysDefault).toBe(30);
  });
});

/** Foundations FD-032: the Remote Config rows of OPERATOR_LIMITS (Remote Config section 14, RC-002, RC-046). */
describe('the config operator limits', () => {
  it('default to section 14 of the Remote Config PRD', () => {
    expect(parseOperatorLimits({})).toMatchObject({
      configRefreshMinutesMin: 5,
      configRefreshMinutesMax: 1_440,
      configRefreshMinutesDefault: 60,
      configFetchPerKeyFiveMinutes: 900_000,
      configFetchPerKeyHour: 9_000_000,
      configFetchPerInstallationFiveMinutes: 30,
      configFetchPerAddressPerMinute: 6_000,
    });
  });

  it('takes an override within the hard limits', () => {
    const limits = parseOperatorLimits({ INLET_CONFIG_REFRESH_MINUTES_MIN: '1', INLET_CONFIG_REFRESH_MINUTES_MAX: '10080', INLET_LIMIT_CONFIG_PER_INSTALLATION_5M: '60' });
    expect(limits).toMatchObject({ configRefreshMinutesMin: 1, configRefreshMinutesMax: 10_080, configFetchPerInstallationFiveMinutes: 60 });
  });

  it('refuses a value outside its hard limits, naming it', () => {
    expect(() => parseOperatorLimits({ INLET_CONFIG_REFRESH_MINUTES_MAX: '10081' })).toThrow(/INLET_CONFIG_REFRESH_MINUTES_MAX: must be an integer from 1 to 10080/);
    expect(() => parseOperatorLimits({ INLET_CONFIG_REFRESH_MINUTES_MIN: '0' })).toThrow(/INLET_CONFIG_REFRESH_MINUTES_MIN/);
    expect(() => parseOperatorLimits({ INLET_LIMIT_CONFIG_PER_KEY_5M: '999' })).toThrow(/INLET_LIMIT_CONFIG_PER_KEY_5M/);
    expect(() => parseOperatorLimits({ INLET_LIMIT_CONFIG_PER_INSTALLATION_5M: '4' })).toThrow(/INLET_LIMIT_CONFIG_PER_INSTALLATION_5M/);
    expect(() => parseOperatorLimits({ INLET_LIMIT_CONFIG_PER_ADDRESS_PER_MINUTE: 'lots' })).toThrow(/INLET_LIMIT_CONFIG_PER_ADDRESS_PER_MINUTE/);
  });

  it('keeps MIN ≤ DEFAULT ≤ MAX for the refresh interval', () => {
    expect(() => parseOperatorLimits({ INLET_CONFIG_REFRESH_MINUTES_DEFAULT: '2' })).toThrow(/INLET_CONFIG_REFRESH_MINUTES_\*: MIN ≤ DEFAULT ≤ MAX/);
    expect(() => parseOperatorLimits({ INLET_CONFIG_REFRESH_MINUTES_MAX: '30' })).toThrow(/INLET_CONFIG_REFRESH_MINUTES_\*/);
    expect(parseOperatorLimits({ INLET_CONFIG_REFRESH_MINUTES_DEFAULT: '5' }).configRefreshMinutesDefault).toBe(5);
  });
});
