import { describe, expect, it } from 'vitest';
import { loadEnv, parseTrustProxy } from '../../src/env.js';
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
