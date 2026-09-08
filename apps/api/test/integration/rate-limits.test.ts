import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, ids, referenceDefinition, type Harness } from '../setup/harness.js';
import { errorCode, setupPublishedForm, withKey } from '../setup/api.js';

/**
 * FR-088: non-configurable platform security rate limits.
 *
 * The rest of the suite disables them so hundreds of assertions do not trip them.
 * This file is the one that turns them on, so the guarantee is actually exercised.
 */
describe('security rate limits', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({ INLET_DISABLE_RATE_LIMITS: 'false' });
  });
  afterAll(async () => {
    await h.close();
  });

  it('throttles repeated sign-in attempts', async () => {
    let limited = false;
    for (let i = 0; i < 20 && !limited; i += 1) {
      const response = await h.app.inject({
        method: 'POST',
        url: '/v1/auth/sign-in',
        payload: { email: 'attacker@example.com', password: 'guess' },
      });
      if (response.statusCode === 429) {
        expect(errorCode(response)).toBe('rate_limit_exceeded');
        expect(JSON.parse(response.body)).toEqual({
          error: {
            code: 'rate_limit_exceeded',
            message: 'Too many requests. Wait a moment and try again.',
          },
        });
        limited = true;
      }
    }
    expect(limited).toBe(true);
  });

  it('throttles submission-intent creation, the operation a public client can spam', async () => {
    const ctx = await setupPublishedForm(h, referenceDefinition(ids()));

    let limited = false;
    for (let i = 0; i < 90 && !limited; i += 1) {
      const response = await withKey(
        h.app,
        ctx.publishableKey,
        'POST',
        `/v1/feedback-databases/${ctx.databaseId}/submission-intents`,
        {},
      );
      if (response.statusCode === 429) {
        expect(errorCode(response)).toBe('rate_limit_exceeded');
        limited = true;
      }
    }
    expect(limited).toBe(true);
  });
});
