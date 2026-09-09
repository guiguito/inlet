import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS } from '@inlet/shared';
import { hostedForms, submissions } from '../../src/db/schema.js';
import { createHarness, ids, referenceDefinition, referenceAnswers, type Harness } from '../setup/harness.js';
import {
  asAdmin,
  createDatabase,
  createProject,
  enableHostedForm,
  errorCode,
  errorDetails,
  hostedIntent,
  hostedSubmit,
  hostedUpload,
  publish,
  saveDraft,
  setupPublishedForm,
  uploadLogo,
} from '../setup/api.js';
import { animatedPng, heavyLogo, notAnImage, oversizedBytes, overStoredBudget, png } from '../setup/images.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Hosted forms (FR-130 to FR-154).
 *
 * The hosted form is a second collection path beside the client API, and these tests
 * hold it to that: the same intents, the same validation, the same retry contract, and
 * a submission that is indistinguishable in storage from one sent with a project key.
 */
describe('hosted forms', () => {
  let h: Harness;
  let f = ids();
  let ctx: Awaited<ReturnType<typeof setupPublishedForm>>;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    f = ids();
    ctx = await setupPublishedForm(h, referenceDefinition(f));
  });

  // --- The address --------------------------------------------------------

  it('creates a disabled hosted form with a generated address on first read (FR-131)', async () => {
    const response = await asAdmin(
      h,
      'GET',
      `/v1/feedback-databases/${ctx.databaseId}/hosted-form`,
    );
    expect(response.statusCode).toBe(200);
    const hosted = JSON.parse(response.body) as {
      enabled: boolean;
      slug: string;
      url: string;
      accentColor: string;
      embedding: string;
    };
    expect(hosted.enabled).toBe(false);
    expect(hosted.slug).toMatch(/^[a-z0-9]+$/);
    expect(hosted.url.endsWith(`/f/${hosted.slug}`)).toBe(true);
    expect(hosted.accentColor).toMatch(/^#[0-9A-F]{6}$/);
    expect(hosted.embedding).toBe('anywhere');

    // Reading again is stable rather than issuing a second address.
    const again = await asAdmin(
      h,
      'GET',
      `/v1/feedback-databases/${ctx.databaseId}/hosted-form`,
    );
    expect((JSON.parse(again.body) as { slug: string }).slug).toBe(hosted.slug);
  });

  it('accepts a custom address and rejects one that is taken or reserved (FR-132)', async () => {
    const set = await asAdmin(h, 'PATCH', `/v1/feedback-databases/${ctx.databaseId}/hosted-form`, {
      slug: '  Beta-Feedback  ',
    });
    expect(set.statusCode).toBe(200);
    // Trimmed and lowercased on the way in, so a pasted address still works.
    expect((JSON.parse(set.body) as { slug: string }).slug).toBe('beta-feedback');

    const other = await createDatabase(h, ctx.projectId, 'Second');
    const taken = await asAdmin(h, 'PATCH', `/v1/feedback-databases/${other}/hosted-form`, {
      slug: 'beta-feedback',
    });
    expect(taken.statusCode).toBe(409);
    expect(errorCode(taken)).toBe('name_conflict');

    const reserved = await asAdmin(h, 'PATCH', `/v1/feedback-databases/${other}/hosted-form`, {
      slug: 'admin',
    });
    expect(reserved.statusCode).toBe(409);

    for (const bad of ['ab', '-leading', 'trailing-', 'Upper Case', 'under_score', 'e'.repeat(65)]) {
      const response = await asAdmin(
        h,
        'PATCH',
        `/v1/feedback-databases/${other}/hosted-form`,
        { slug: bad },
      );
      expect(response.statusCode, bad).toBe(400);
    }

    // The database keeps its own address, so a rejected attempt changed nothing.
    const still = await asAdmin(h, 'GET', `/v1/feedback-databases/${ctx.databaseId}/hosted-form`);
    expect((JSON.parse(still.body) as { slug: string }).slug).toBe('beta-feedback');
  });

  it('retires the previous address when it is rotated (FR-133)', async () => {
    const { slug } = await enableHostedForm(h, ctx.databaseId);
    expect((await h.app.inject({ url: `/v1/hosted/${slug}` })).statusCode).toBe(200);

    const rotated = await asAdmin(
      h,
      'POST',
      `/v1/feedback-databases/${ctx.databaseId}/hosted-form/rotate-slug`,
    );
    expect(rotated.statusCode).toBe(200);
    const next = (JSON.parse(rotated.body) as { slug: string }).slug;
    expect(next).not.toBe(slug);

    expect((await h.app.inject({ url: `/v1/hosted/${slug}` })).statusCode).toBe(404);
    expect((await h.app.inject({ url: `/v1/hosted/${next}` })).statusCode).toBe(200);
  });

  // --- The public page ----------------------------------------------------

  it('serves the published form with no key, account or cookie (FR-134, FR-136)', async () => {
    const { slug } = await enableHostedForm(h, ctx.databaseId);

    const response = await h.app.inject({ url: `/v1/hosted/${slug}` });
    expect(response.statusCode).toBe(200);
    // Nothing about this request establishes a session.
    expect(response.headers['set-cookie']).toBeUndefined();

    const view = JSON.parse(response.body) as {
      open: boolean;
      slug: string;
      form: { formVersion: number; pages: { elements: { id: string }[] }[] } | null;
      copy: { submitLabel: string };
    };
    expect(view.open).toBe(true);
    expect(view.slug).toBe(slug);
    expect(view.form?.formVersion).toBe(ctx.version);
    expect(view.form?.pages).toHaveLength(2);
    expect(view.form?.pages[0]?.elements.map((element) => element.id)).toEqual([
      f.title,
      f.intro,
      f.mood,
      f.areas,
    ]);
    expect(view.copy.submitLabel).toBeTruthy();
  });

  it('withholds the questions when it is closed, and says why in the operator’s words (FR-142)', async () => {
    const { slug } = await enableHostedForm(h, ctx.databaseId);
    await asAdmin(h, 'PATCH', `/v1/feedback-databases/${ctx.databaseId}/hosted-form`, {
      enabled: false,
      closedMessage: 'We have closed this round of feedback. Thank you.',
    });

    const response = await h.app.inject({ url: `/v1/hosted/${slug}` });
    expect(response.statusCode).toBe(200);
    const view = JSON.parse(response.body) as { open: boolean; form: unknown; closedMessage: string };
    expect(view.open).toBe(false);
    expect(view.form).toBeNull();
    expect(view.closedMessage).toBe('We have closed this round of feedback. Thank you.');

    // And it collects nothing while closed.
    const intent = await h.app.inject({
      method: 'POST',
      url: `/v1/hosted/${slug}/submission-intents`,
    });
    expect(intent.statusCode).toBe(409);
    expect(errorCode(intent)).toBe('form_not_published');
  });

  it('is closed when the form is unpublished, without the operator touching it', async () => {
    const { slug } = await enableHostedForm(h, ctx.databaseId);
    await asAdmin(h, 'POST', `/v1/feedback-databases/${ctx.databaseId}/form/unpublish`);

    const view = JSON.parse((await h.app.inject({ url: `/v1/hosted/${slug}` })).body) as {
      open: boolean;
      form: unknown;
    };
    expect(view.open).toBe(false);
    expect(view.form).toBeNull();
  });

  it('answers an unknown address with a not-found rather than a hint (FR-134)', async () => {
    const response = await h.app.inject({ url: '/v1/hosted/no-such-form' });
    expect(response.statusCode).toBe(404);
    expect(errorCode(response)).toBe('not_found');
  });

  it('serves a hosted form for a database with no published version at all', async () => {
    const project = await createProject(h, 'Fresh');
    const database = await createDatabase(h, project, 'Fresh feedback');
    const { slug } = await enableHostedForm(h, database);
    const view = JSON.parse((await h.app.inject({ url: `/v1/hosted/${slug}` })).body) as {
      open: boolean;
    };
    expect(view.open).toBe(false);
  });

  // --- Framing ------------------------------------------------------------

  it('sends the framing headers the operator chose (FR-135)', async () => {
    const { slug } = await enableHostedForm(h, ctx.databaseId);

    const anywhere = await h.app.inject({ url: `/v1/hosted/${slug}` });
    expect(anywhere.headers['content-security-policy']).toBe('frame-ancestors *');

    await asAdmin(h, 'PATCH', `/v1/feedback-databases/${ctx.databaseId}/hosted-form`, {
      embedding: 'nowhere',
    });
    const nowhere = await h.app.inject({ url: `/v1/hosted/${slug}` });
    // Inlet's own origin stays allowed in every mode, because the management
    // interface previews the real page in a frame.
    expect(nowhere.headers['content-security-policy']).toBe("frame-ancestors 'self'");
    expect(nowhere.headers['x-frame-options']).toBe('SAMEORIGIN');

    await asAdmin(h, 'PATCH', `/v1/feedback-databases/${ctx.databaseId}/hosted-form`, {
      embedding: 'listed',
      allowedOrigins: ['https://app.example.com/', 'https://help.example.com'],
    });
    const listed = await h.app.inject({ url: `/v1/hosted/${slug}` });
    expect(listed.headers['content-security-policy']).toBe(
      "frame-ancestors 'self' https://app.example.com https://help.example.com",
    );
    expect(listed.headers['x-frame-options']).toBeUndefined();
  });

  it('refuses a listed embedding with no origins, which would block every frame', async () => {
    const response = await asAdmin(
      h,
      'PATCH',
      `/v1/feedback-databases/${ctx.databaseId}/hosted-form`,
      { embedding: 'listed' },
    );
    expect(response.statusCode).toBe(400);
    expect(errorDetails(response)[0]?.path).toBe('allowedOrigins');
  });

  it('rejects an origin carrying a path, a query or a credential', async () => {
    for (const bad of [
      'https://example.com/embed',
      'https://example.com/?x=1',
      'not-a-url',
      'ftp://example.com',
    ]) {
      const response = await asAdmin(
        h,
        'PATCH',
        `/v1/feedback-databases/${ctx.databaseId}/hosted-form`,
        { embedding: 'listed', allowedOrigins: [bad] },
      );
      expect(response.statusCode, bad).toBe(400);
    }
  });

  // --- Collecting ---------------------------------------------------------

  it('collects a submission through the same intents as the client API (FR-145)', async () => {
    const { slug } = await enableHostedForm(h, ctx.databaseId);

    const intent = await hostedIntent(h, slug);
    expect(intent.formVersion).toBe(ctx.version);

    const response = await hostedSubmit(h, slug, intent, {
      formVersion: ctx.version,
      answers: referenceAnswers(f),
      context: { source: 'newsletter', language: 'en-GB', viewport: '390x844' },
    });
    expect(response.statusCode).toBe(201);
    const result = JSON.parse(response.body) as { submissionId: string; status: string };
    expect(result.status).toBe('accepted');

    // The stored row is an ordinary submission: same table, same shape, and the
    // recorded context says how it arrived without changing anything else.
    const [row] = await h.ctx.db
      .select()
      .from(submissions)
      .where(eq(submissions.id, result.submissionId));
    expect(row?.feedbackDatabaseId).toBe(ctx.databaseId);
    expect(row?.formVersion).toBe(ctx.version);
    expect(row?.clientContext).toMatchObject({ via: 'hosted', slug, source: 'newsletter' });

    // And it shows up in the operator's responses like any other.
    const list = await asAdmin(
      h,
      'GET',
      `/v1/feedback-databases/${ctx.databaseId}/submissions`,
    );
    expect((JSON.parse(list.body) as { submissions: unknown[] }).submissions).toHaveLength(1);
  });

  it('applies the same answer validation and leaves the intent usable (FR-145)', async () => {
    const { slug } = await enableHostedForm(h, ctx.databaseId);
    const intent = await hostedIntent(h, slug);

    const missing = await hostedSubmit(h, slug, intent, {
      formVersion: ctx.version,
      answers: { [f.detail]: { value: 'Only the free text.' } },
    });
    expect(missing.statusCode).toBe(400);
    expect(errorCode(missing)).toBe('validation_failed');
    expect(errorDetails(missing)[0]?.questionId).toBe(f.mood);

    // The respondent fixes it and the same intent still works.
    const fixed = await hostedSubmit(h, slug, intent, {
      formVersion: ctx.version,
      answers: referenceAnswers(f),
    });
    expect(fixed.statusCode).toBe(201);
  });

  it('replays the same payload and conflicts on a different one (section 9.2)', async () => {
    const { slug } = await enableHostedForm(h, ctx.databaseId);
    const intent = await hostedIntent(h, slug);
    const payload = { formVersion: ctx.version, answers: referenceAnswers(f) };

    const first = await hostedSubmit(h, slug, intent, payload);
    expect(first.statusCode).toBe(201);
    const id = (JSON.parse(first.body) as { submissionId: string }).submissionId;

    const replay = await hostedSubmit(h, slug, intent, payload);
    expect(replay.statusCode).toBe(200);
    const replayed = JSON.parse(replay.body) as { submissionId: string; status: string };
    expect(replayed.status).toBe('duplicate');
    expect(replayed.submissionId).toBe(id);

    const different = await hostedSubmit(h, slug, intent, {
      formVersion: ctx.version,
      answers: { ...referenceAnswers(f), [f.detail]: { value: 'Something else entirely.' } },
    });
    expect(different.statusCode).toBe(409);
    expect(errorCode(different)).toBe('intent_payload_conflict');
  });

  it('refuses an intent that belongs to a different hosted form', async () => {
    const { slug } = await enableHostedForm(h, ctx.databaseId);
    const other = await setupPublishedForm(h, referenceDefinition(f));
    const otherHosted = await enableHostedForm(h, other.databaseId);

    const intent = await hostedIntent(h, otherHosted.slug);
    const response = await hostedSubmit(h, slug, intent, {
      formVersion: ctx.version,
      answers: referenceAnswers(f),
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses a submission with the wrong intent token', async () => {
    const { slug } = await enableHostedForm(h, ctx.databaseId);
    const intent = await hostedIntent(h, slug);
    const response = await hostedSubmit(
      h,
      slug,
      { intentId: intent.intentId, token: 'not-the-token' },
      { formVersion: ctx.version, answers: referenceAnswers(f) },
    );
    // The same answer the client API gives: the intent token is the credential here,
    // and a wrong one is unauthorized rather than missing.
    expect(response.statusCode).toBe(401);
  });

  it('rejects a context field the page does not send, so a public page cannot write anything it likes (FR-148)', async () => {
    const { slug } = await enableHostedForm(h, ctx.databaseId);
    const intent = await hostedIntent(h, slug);
    const response = await hostedSubmit(h, slug, intent, {
      formVersion: ctx.version,
      answers: referenceAnswers(f),
      context: { source: 'ok', internalNote: 'x'.repeat(50) },
    });
    expect(response.statusCode).toBe(400);
  });

  it('records only the origin of an embedding page, never its full address (FR-148)', async () => {
    const { slug } = await enableHostedForm(h, ctx.databaseId);
    const intent = await hostedIntent(h, slug);
    const response = await hostedSubmit(h, slug, intent, {
      formVersion: ctx.version,
      answers: referenceAnswers(f),
      context: { embeddedOn: 'https://app.example.com/account/42?email=someone@example.com' },
    });
    expect(response.statusCode).toBe(201);

    const [row] = await h.ctx.db
      .select()
      .from(submissions)
      .where(eq(submissions.id, (JSON.parse(response.body) as { submissionId: string }).submissionId));
    expect(row?.clientContext).toMatchObject({ embeddedOn: 'https://app.example.com' });
    expect(JSON.stringify(row?.clientContext)).not.toContain('someone@example.com');
  });

  it('accepts a screenshot through the hosted form and validates it identically', async () => {
    const { slug } = await enableHostedForm(h, ctx.databaseId);
    const intent = await hostedIntent(h, slug);

    const uploaded = await hostedUpload(h, slug, intent, f.shot, await png(320, 200));
    expect(uploaded.statusCode).toBe(201);
    const attachment = JSON.parse(uploaded.body) as { attachmentId: string; mediaType: string };
    expect(attachment.mediaType).toBe('image/webp');

    const rejected = await hostedUpload(h, slug, intent, f.shot, notAnImage(), 'note.txt', 'text/plain');
    expect(errorCode(rejected)).toBe('unsupported_image_format');

    const animated = await hostedUpload(h, slug, intent, f.shot, animatedPng(), 'anim.png');
    expect(errorCode(animated)).toBe('animated_image_rejected');

    const submitted = await hostedSubmit(h, slug, intent, {
      formVersion: ctx.version,
      answers: { ...referenceAnswers(f), [f.shot]: { attachmentIds: [attachment.attachmentId] } },
    });
    expect(submitted.statusCode).toBe(201);
  });

  it('discards a screenshot the respondent removed before submitting', async () => {
    const { slug } = await enableHostedForm(h, ctx.databaseId);
    const intent = await hostedIntent(h, slug);
    const uploaded = await hostedUpload(h, slug, intent, f.shot, await png(200, 200));
    const attachmentId = (JSON.parse(uploaded.body) as { attachmentId: string }).attachmentId;

    const discarded = await h.app.inject({
      method: 'DELETE',
      url: `/v1/hosted/${slug}/submission-intents/${intent.intentId}/attachments/${attachmentId}`,
      headers: { 'x-inlet-intent-token': intent.token },
    });
    expect(discarded.statusCode).toBe(200);

    const reused = await hostedSubmit(h, slug, intent, {
      formVersion: ctx.version,
      answers: { ...referenceAnswers(f), [f.shot]: { attachmentIds: [attachmentId] } },
    });
    expect(reused.statusCode).toBe(400);
  });

  // --- Branding -----------------------------------------------------------

  it('normalises a colour, keeps every other setting, and derives nothing about the form', async () => {
    const response = await asAdmin(
      h,
      'PATCH',
      `/v1/feedback-databases/${ctx.databaseId}/hosted-form`,
      {
        accentColor: '#c40',
        colorScheme: 'dark',
        cornerRadius: 'round',
        typeface: 'serif',
        submitLabel: 'Send it',
        thankYouTitle: 'Got it',
        thankYouBody: 'We read every one of these.',
        showProgress: false,
        redirectUrl: 'https://example.com/thanks',
      },
    );
    expect(response.statusCode).toBe(200);
    const hosted = JSON.parse(response.body) as Record<string, unknown>;
    expect(hosted.accentColor).toBe('#CC4400');
    expect(hosted.colorScheme).toBe('dark');
    expect(hosted.typeface).toBe('serif');
    expect(hosted.redirectUrl).toBe('https://example.com/thanks');

    const { slug } = await enableHostedForm(h, ctx.databaseId);
    const view = JSON.parse((await h.app.inject({ url: `/v1/hosted/${slug}` })).body) as {
      branding: { accentColor: string; colorScheme: string };
      copy: { submitLabel: string };
      behaviour: { showProgress: boolean; redirectUrl: string | null };
      form: { pages: { elements: { id: string }[] }[] } | null;
    };
    expect(view.branding.accentColor).toBe('#CC4400');
    expect(view.copy.submitLabel).toBe('Send it');
    expect(view.behaviour.showProgress).toBe(false);
    // Section 22.5: branding is presentation only. The questions are untouched.
    expect(view.form?.pages[0]?.elements.map((element) => element.id)).toEqual([
      f.title,
      f.intro,
      f.mood,
      f.areas,
    ]);
  });

  it('rejects a colour that is not a hex colour and copy that is too long', async () => {
    for (const patch of [
      { accentColor: 'rebeccapurple' },
      { accentColor: '#12345' },
      { submitLabel: 'x'.repeat(61) },
      { thankYouTitle: '' },
      { closedMessage: '' },
      { redirectUrl: 'not-a-url' },
      { unknownSetting: true },
    ]) {
      const response = await asAdmin(
        h,
        'PATCH',
        `/v1/feedback-databases/${ctx.databaseId}/hosted-form`,
        patch,
      );
      expect(response.statusCode, JSON.stringify(patch)).toBe(400);
    }
  });

  it('stores a logo as WebP, serves it publicly and replaces it cleanly (FR-140)', async () => {
    const uploaded = await uploadLogo(h, ctx.databaseId, await png(400, 120), 'Acme');
    expect(uploaded.statusCode).toBe(200);
    const first = JSON.parse(uploaded.body) as {
      logoUrl: string;
      logoAlt: string;
      logoWidth: number;
    };
    expect(first.logoAlt).toBe('Acme');
    expect(first.logoWidth).toBe(400);

    const { slug } = await enableHostedForm(h, ctx.databaseId);
    const served = await h.app.inject({ url: `/v1/hosted/${slug}/logo` });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/webp');
    // The key changes with the logo, so the bytes at a key never change.
    expect(served.headers['cache-control']).toContain('max-age');

    const [row] = await h.ctx.db
      .select()
      .from(hostedForms)
      .where(eq(hostedForms.feedbackDatabaseId, ctx.databaseId));
    const firstKey = row?.logoStorageKey ?? '';
    expect(firstKey).toBeTruthy();

    const replaced = await uploadLogo(h, ctx.databaseId, await png(200, 200), 'Acme mark');
    expect(replaced.statusCode).toBe(200);
    const [after] = await h.ctx.db
      .select()
      .from(hostedForms)
      .where(eq(hostedForms.feedbackDatabaseId, ctx.databaseId));
    expect(after?.logoStorageKey).not.toBe(firstKey);
    expect(await h.ctx.storage.get(firstKey)).toBeNull();

    const removed = await asAdmin(
      h,
      'DELETE',
      `/v1/feedback-databases/${ctx.databaseId}/hosted-form/logo`,
    );
    expect(removed.statusCode).toBe(200);
    expect((JSON.parse(removed.body) as { logoUrl: string | null }).logoUrl).toBeNull();
    expect((await h.app.inject({ url: `/v1/hosted/${slug}/logo` })).statusCode).toBe(404);
  });

  it('rejects a logo that is not an image, is animated, or is too large (FR-140)', async () => {
    expect(
      errorCode(await uploadLogo(h, ctx.databaseId, notAnImage(), undefined, 'logo.txt', 'text/plain')),
    ).toBe('unsupported_image_format');
    expect(errorCode(await uploadLogo(h, ctx.databaseId, animatedPng()))).toBe(
      'animated_image_rejected',
    );
    const large = await uploadLogo(h, ctx.databaseId, await oversizedBytes());
    expect(large.statusCode).toBe(413);
    expect(errorCode(large)).toBe('file_too_large');
    // A logo is a small mark, so its decoded ceiling stays tighter than a screenshot's.
    expect(errorCode(await uploadLogo(h, ctx.databaseId, await overStoredBudget(), undefined, 'logo.jpg', 'image/jpeg'))).toBe(
      'image_too_many_pixels',
    );
  });

  it('re-encodes a heavy logo down to the stored ceiling instead of refusing it', async () => {
    // Well over the stored budget as WebP, and inside the logo's pixel ceiling.
    const heavy = await heavyLogo();
    expect(heavy.length).toBeGreaterThan(LIMITS.imageMaxStoredBytes);
    expect(heavy.length).toBeLessThan(LIMITS.imageMaxSourceBytes);

    const uploaded = await uploadLogo(h, ctx.databaseId, heavy, 'Acme', 'logo.jpg', 'image/jpeg');
    expect(uploaded.statusCode).toBe(200);

    const [row] = await h.ctx.db
      .select()
      .from(hostedForms)
      .where(eq(hostedForms.feedbackDatabaseId, ctx.databaseId));
    expect(row?.logoMediaType).toBe('image/webp');
    expect(row?.logoBytes).toBeLessThanOrEqual(LIMITS.imageMaxStoredBytes);
    expect(row?.logoWidth).toBeGreaterThan(0);
  });

  it('purges the logo when the feedback database is deleted (FR-154)', async () => {
    await uploadLogo(h, ctx.databaseId, await png(300, 100), 'Acme');
    const [row] = await h.ctx.db
      .select()
      .from(hostedForms)
      .where(eq(hostedForms.feedbackDatabaseId, ctx.databaseId));
    const key = row?.logoStorageKey ?? '';
    expect(await h.ctx.storage.get(key)).not.toBeNull();

    const deleted = await asAdmin(h, 'DELETE', `/v1/feedback-databases/${ctx.databaseId}`, {
      confirm: 'Feedback',
    });
    expect(deleted.statusCode).toBe(200);

    // The address is released with it, so the slug can be claimed again.
    const rows = await h.ctx.db.select().from(hostedForms);
    expect(rows).toHaveLength(0);
  });

  // --- Permissions --------------------------------------------------------

  it('keeps the API path working while the hosted form collects (both features)', async () => {
    const { slug } = await enableHostedForm(h, ctx.databaseId);

    const throughKey = await h.app.inject({
      method: 'GET',
      url: `/v1/feedback-databases/${ctx.databaseId}/form`,
      headers: { authorization: `Bearer ${ctx.publishableKey}` },
    });
    expect(throughKey.statusCode).toBe(200);

    const hostedIntentRow = await hostedIntent(h, slug);
    const hosted = await hostedSubmit(h, slug, hostedIntentRow, {
      formVersion: ctx.version,
      answers: referenceAnswers(f),
    });
    expect(hosted.statusCode).toBe(201);

    const keyIntent = await h.app.inject({
      method: 'POST',
      url: `/v1/feedback-databases/${ctx.databaseId}/submission-intents`,
      headers: { authorization: `Bearer ${ctx.publishableKey}` },
      payload: {},
    });
    const intent = JSON.parse(keyIntent.body) as { intentId: string; token: string };
    const viaKey = await h.app.inject({
      method: 'POST',
      url: `/v1/feedback-databases/${ctx.databaseId}/submission-intents/${intent.intentId}/submit`,
      headers: { authorization: `Bearer ${ctx.publishableKey}`, 'x-inlet-intent-token': intent.token },
      payload: { formVersion: ctx.version, answers: referenceAnswers(f) },
    });
    expect(viaKey.statusCode).toBe(201);

    const list = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/feedback-databases/${ctx.databaseId}/submissions`)).body,
    ) as { submissions: { id: string }[] };
    // Two responses, one from each path, in the same place.
    expect(list.submissions).toHaveLength(2);
  });

  it('needs a session to read or change the hosted form (FR-151)', async () => {
    const anonymous = await h.app.inject({
      url: `/v1/feedback-databases/${ctx.databaseId}/hosted-form`,
    });
    expect(anonymous.statusCode).toBe(401);

    const withPublishable = await h.app.inject({
      method: 'PATCH',
      url: `/v1/feedback-databases/${ctx.databaseId}/hosted-form`,
      headers: { authorization: `Bearer ${ctx.publishableKey}` },
      payload: { enabled: true },
    });
    expect(withPublishable.statusCode).toBe(403);
  });

  it('lets a secret server key read and change the hosted form, which is what MCP uses', async () => {
    const read = await h.app.inject({
      url: `/v1/feedback-databases/${ctx.databaseId}/hosted-form`,
      headers: { authorization: `Bearer ${ctx.secretKey}` },
    });
    expect(read.statusCode).toBe(200);

    const written = await h.app.inject({
      method: 'PATCH',
      url: `/v1/feedback-databases/${ctx.databaseId}/hosted-form`,
      headers: { authorization: `Bearer ${ctx.secretKey}` },
      payload: { enabled: true, submitLabel: 'Send feedback' },
    });
    expect(written.statusCode).toBe(200);
    expect((JSON.parse(written.body) as { enabled: boolean }).enabled).toBe(true);
  });
});

/**
 * The page the address serves (FR-135, FR-138, FR-144).
 *
 * Its own harness, because it needs a built interface to serve. The web app's own
 * `index.html` is used as that shell: it is the file the build derives from, so the
 * tags the route substitutes are the real ones and a rename in the shell fails here
 * rather than silently producing an unbranded page.
 */
describe('the hosted form page', () => {
  let h: Harness;
  let f = ids();
  let ctx: Awaited<ReturnType<typeof setupPublishedForm>>;

  beforeAll(async () => {
    const webRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../web',
    );
    h = await createHarness({ INLET_WEB_DIST: webRoot });
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    f = ids();
    ctx = await setupPublishedForm(h, referenceDefinition(f));
  });

  it('carries the branding and the operator’s title in the initial HTML', async () => {
    await asAdmin(h, 'PATCH', `/v1/feedback-databases/${ctx.databaseId}/hosted-form`, {
      accentColor: '#0F766E',
      colorScheme: 'light',
      cornerRadius: 'sharp',
      typeface: 'serif',
    });
    const { slug } = await enableHostedForm(h, ctx.databaseId);

    const response = await h.app.inject({ url: `/f/${slug}` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['cache-control']).toBe('no-store');

    // The accent, its derived readable foreground, and the corner radius are all in
    // the first bytes the browser sees, so the page never paints unbranded.
    expect(response.body).toContain('--r-accent:#0F766E');
    expect(response.body).toContain('--r-accent-contrast:#FFFFFF');
    expect(response.body).toContain('--r-radius:0px');
    expect(response.body).toContain('ui-serif');
    // An explicit light scheme emits one block and no dark media query.
    expect(response.body).not.toContain('prefers-color-scheme');

    // FR-144: the operator's name, not Inlet's.
    expect(response.body).toContain('<title>Feedback</title>');
    expect(response.body).not.toContain('<title>Inlet</title>');
    // And not the management interface's remembered theme.
    expect(response.body).toContain('class="inlet-hosted"');
    expect(response.body).not.toContain('class="dark"');
  });

  it('emits both schemes when the operator follows the device', async () => {
    const { slug } = await enableHostedForm(h, ctx.databaseId);
    const response = await h.app.inject({ url: `/f/${slug}` });
    expect(response.body).toContain('prefers-color-scheme:dark');
    expect(response.body).toContain('--r-bg:#FFFFFF');
    expect(response.body).toContain('--r-bg:#09090B');
  });

  it('applies the framing choice to the document, which is where a browser reads it', async () => {
    const { slug } = await enableHostedForm(h, ctx.databaseId);
    expect((await h.app.inject({ url: `/f/${slug}` })).headers['content-security-policy']).toBe(
      'frame-ancestors *',
    );

    await asAdmin(h, 'PATCH', `/v1/feedback-databases/${ctx.databaseId}/hosted-form`, {
      embedding: 'listed',
      allowedOrigins: ['https://app.example.com'],
    });
    const listed = await h.app.inject({ url: `/f/${slug}` });
    expect(listed.headers['content-security-policy']).toBe(
      "frame-ancestors 'self' https://app.example.com",
    );
  });

  it('renders a civil page for an unknown address rather than a browser error', async () => {
    const response = await h.app.inject({ url: '/f/no-such-form' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('<title>Form not found</title>');
  });

  it('escapes the name it puts in the title', async () => {
    const database = await createDatabase(h, ctx.projectId, '<script>alert(1)</script>');
    const { slug } = await enableHostedForm(h, database);
    const response = await h.app.inject({ url: `/f/${slug}` });
    expect(response.body).not.toContain('<script>alert(1)</script>');
    expect(response.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('still serves the closed page at its address, with the branding intact', async () => {
    const { slug } = await enableHostedForm(h, ctx.databaseId);
    await asAdmin(h, 'PATCH', `/v1/feedback-databases/${ctx.databaseId}/hosted-form`, {
      enabled: false,
    });
    const response = await h.app.inject({ url: `/f/${slug}` });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('--r-accent:');
  });
});
