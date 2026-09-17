import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, ids, referenceDefinition, type Harness } from '../setup/harness.js';
import {
  createDatabase,
  enableHostedForm,
  errorCode,
  publish,
  saveDraft,
  setupPublishedForm,
  withKey,
} from '../setup/api.js';

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

  it('throttles invitation redemption, which needs no account to attempt', async () => {
    // The token is nonsense on purpose: the limiter runs before the token is looked
    // up, so guessing at addresses is bounded whether or not any of them exist.
    let limited = false;
    for (let i = 0; i < 40 && !limited; i += 1) {
      const response = await h.app.inject({
        method: 'POST',
        url: `/v1/invitations/guess-${i}/redeem`,
        payload: { email: 'nobody@example.com', password: 'a-long-enough-password' },
      });
      if (response.statusCode === 429) {
        expect(errorCode(response)).toBe('rate_limit_exceeded');
        limited = true;
      }
    }
    expect(limited).toBe(true);
  });

  describe('a hosted form (FR-149)', () => {
    /**
     * The address half of FR-149 is the shared limiter every route gets. This covers
     * the slug half, which is the one a public link actually needs: an address-keyed
     * limit bounds one caller and says nothing about one form, so the check rotates
     * the address on every request. Nothing but the per-slug limiter can refuse these.
     */
    it('limits per slug, not only per address, and leaves other forms alone', async () => {
      const busy = await setupPublishedForm(h, referenceDefinition(ids()));
      const busySlug = (await enableHostedForm(h, busy.databaseId)).slug;

      const quietId = await createDatabase(h, busy.projectId, 'Quiet');
      await saveDraft(h, quietId, referenceDefinition(ids()));
      await publish(h, quietId);
      const quietSlug = (await enableHostedForm(h, quietId)).slug;

      let refusal: { statusCode: number; body: string; headers: Record<string, unknown> } | null =
        null;
      for (let i = 0; i < 700 && !refusal; i += 1) {
        const response = await h.app.inject({
          method: 'POST',
          url: `/v1/hosted/${busySlug}/submission-intents`,
          // A different caller every time, so the address-keyed limits never trip.
          remoteAddress: `10.${Math.floor(i / 65536) % 256}.${Math.floor(i / 256) % 256}.${i % 256}`,
        });
        if (response.statusCode === 429) refusal = response;
      }

      expect(refusal).not.toBeNull();
      expect(errorCode(refusal!)).toBe('rate_limit_exceeded');
      // The wording identifies which limiter refused: the per-address one says
      // "Too many requests", this one names the form.
      expect(JSON.parse(refusal!.body).error.message).toContain('This form is receiving too many');
      // FD-030: a 429 says how long to wait.
      expect(Number(refusal!.headers['retry-after'])).toBeGreaterThan(0);

      // A second form is a second slug, so it is untouched by the first one's flood.
      const other = await h.app.inject({
        method: 'POST',
        url: `/v1/hosted/${quietSlug}/submission-intents`,
        remoteAddress: '198.51.100.7',
      });
      expect(other.statusCode).toBe(201);
    });
  });
});
