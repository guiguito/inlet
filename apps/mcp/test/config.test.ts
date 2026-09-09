import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/app.js';

/**
 * Configuration for `inlet-mcp`.
 *
 * The messages matter more than usual here: this runs as a subprocess of an agent, so
 * an operator debugging it sees only what reaches stderr.
 */
describe('loadConfig', () => {
  const valid = {
    INLET_URL: 'https://inlet.example.com',
    INLET_SECRET_KEY: 'isk_abcdefghijklmnop',
  };

  it('accepts a deployment URL and a secret server key', () => {
    expect(loadConfig(valid)).toEqual({
      baseUrl: 'https://inlet.example.com',
      secretKey: 'isk_abcdefghijklmnop',
    });
  });

  it('trims whitespace around both values', () => {
    expect(
      loadConfig({ INLET_URL: '  https://inlet.example.com  ', INLET_SECRET_KEY: ' isk_x ' }),
    ).toMatchObject({ baseUrl: 'https://inlet.example.com', secretKey: 'isk_x' });
  });

  it('says what to set when the URL is missing', () => {
    expect(() => loadConfig({ INLET_SECRET_KEY: 'isk_x' })).toThrow(/Set INLET_URL/);
  });

  it('says what to set when the key is missing', () => {
    expect(() => loadConfig({ INLET_URL: 'https://inlet.example.com' })).toThrow(
      /Set INLET_SECRET_KEY/,
    );
  });

  it('rejects a URL that is not a URL', () => {
    expect(() => loadConfig({ ...valid, INLET_URL: 'inlet.example.com' })).toThrow(
      /not a valid URL/,
    );
  });

  it('rejects a publishable key, explaining why it cannot work', () => {
    expect(() => loadConfig({ ...valid, INLET_SECRET_KEY: 'ipk_public' })).toThrow(
      /must be a secret server key/,
    );
  });

  it('takes an optional timeout and ignores a nonsensical one', () => {
    expect(loadConfig({ ...valid, INLET_TIMEOUT_MS: '5000' }).timeoutMs).toBe(5000);
    expect(loadConfig({ ...valid, INLET_TIMEOUT_MS: 'soon' }).timeoutMs).toBeUndefined();
  });
});
