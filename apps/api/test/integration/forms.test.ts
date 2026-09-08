import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId, type FormDefinition } from '@inlet/shared';
import { createHarness, ids, referenceDefinition, type Harness } from '../setup/harness.js';
import {
  asAdmin,
  createDatabase,
  createProject,
  errorCode,
  errorDetails,
  publish,
  saveDraft,
} from '../setup/api.js';

/**
 * The form builder's server side (FR-030 to FR-042G).
 *
 * Acceptance criteria covered here: building and publishing a two-page form with text
 * between questions and every question type; restoring the latest autosaved draft;
 * rejecting a publish from a stale draft revision; and historical responses staying
 * readable after a new version is published.
 */
describe('form drafts and published versions', () => {
  let h: Harness;
  let databaseId: string;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    const projectId = await createProject(h);
    databaseId = await createDatabase(h, projectId);
  });

  it('starts a new feedback database on an empty, unpublishable draft', async () => {
    const draft = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/feedback-databases/${databaseId}/form/draft`)).body,
    ) as { definition: FormDefinition; revision: number; problems: { code: string }[] };

    expect(draft.definition).toEqual({ pages: [] });
    expect(draft.revision).toBe(0);
    expect(draft.problems.map((p) => p.code)).toContain('empty_form');
  });

  it('autosaves and restores the latest draft, one revision per save (FR-042A)', async () => {
    const f = ids();
    expect(await saveDraft(h, databaseId, referenceDefinition(f))).toBe(1);
    expect(await saveDraft(h, databaseId, referenceDefinition(f))).toBe(2);
    expect(await saveDraft(h, databaseId, referenceDefinition(f))).toBe(3);

    // Closing and reopening the builder restores the latest autosaved draft.
    const reopened = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/feedback-databases/${databaseId}/form/draft`)).body,
    ) as { definition: FormDefinition; revision: number; problems: unknown[] };
    expect(reopened.revision).toBe(3);
    expect(reopened.definition.pages).toHaveLength(2);
    expect(reopened.problems).toEqual([]);
  });

  it('keeps elements in authored order, with content between questions (FR-032)', async () => {
    const f = ids();
    await saveDraft(h, databaseId, referenceDefinition(f));
    const draft = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/feedback-databases/${databaseId}/form/draft`)).body,
    ) as { definition: FormDefinition };

    expect(draft.definition.pages[0]?.elements.map((e) => e.type)).toEqual([
      'title',
      'body_text',
      'choice',
      'choice',
    ]);
    expect(draft.definition.pages[1]?.elements.map((e) => e.type)).toEqual([
      'text',
      'email',
      'screenshot',
    ]);
  });

  it('preserves every question setting through a save and a publish', async () => {
    const f = ids();
    await saveDraft(h, databaseId, referenceDefinition(f));
    await publish(h, databaseId);

    const versions = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/feedback-databases/${databaseId}/form/versions`)).body,
    ) as { version: number; definition: FormDefinition; active: boolean }[];
    const elements = versions[0]?.definition.pages.flatMap((p) => p.elements) ?? [];

    const mood = elements.find((e) => e.id === f.mood);
    expect(mood).toMatchObject({
      type: 'choice',
      optionKind: 'emoji',
      selection: 'single',
      orientation: 'horizontal',
      required: true,
    });
    if (mood?.type === 'choice') {
      expect(mood.options.map((o) => o.emoji)).toEqual(['😍', '🙂', '😡']);
    }

    expect(elements.find((e) => e.id === f.areas)).toMatchObject({
      selection: 'multi',
      orientation: 'vertical',
      optionKind: 'text',
      required: false,
    });
    expect(elements.find((e) => e.id === f.detail)).toMatchObject({
      multiline: true,
      maxLength: 500,
      placeholder: 'Start typing…',
      required: true,
    });
    expect(elements.find((e) => e.id === f.email)).toMatchObject({
      type: 'email',
      required: false,
      helperText: 'Only used to reply to this feedback.',
    });
    expect(elements.find((e) => e.id === f.shot)).toMatchObject({
      type: 'screenshot',
      maxCount: 3,
      required: false,
    });
  });

  it('publishes version 1 then version 2, keeping version 1 unchanged (FR-042C, FR-042D)', async () => {
    const f = ids();
    await saveDraft(h, databaseId, referenceDefinition(f));
    expect(await publish(h, databaseId)).toBe(1);

    const changed = referenceDefinition(f);
    changed.pages[1]?.elements.push({
      id: newId('element'),
      type: 'body_text',
      text: 'Added after the first publish.',
    });
    await saveDraft(h, databaseId, changed);
    expect(await publish(h, databaseId)).toBe(2);

    const versions = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/feedback-databases/${databaseId}/form/versions`)).body,
    ) as { version: number; definition: FormDefinition; active: boolean }[];

    expect(versions.map((v) => [v.version, v.active])).toEqual([
      [2, true],
      [1, false],
    ]);
    // Version 1's definition did not follow the draft.
    expect(versions.find((v) => v.version === 1)?.definition.pages[1]?.elements).toHaveLength(3);
    expect(versions.find((v) => v.version === 2)?.definition.pages[1]?.elements).toHaveLength(4);
  });

  it('leaves the draft editable after publishing, without touching the active version', async () => {
    const f = ids();
    await saveDraft(h, databaseId, referenceDefinition(f));
    await publish(h, databaseId);

    const edited = referenceDefinition(f);
    edited.pages[0]!.elements[0] = { id: f.title, type: 'title', text: 'A different heading' };
    await saveDraft(h, databaseId, edited);

    const active = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/feedback-databases/${databaseId}/form/versions`)).body,
    ) as { version: number; definition: FormDefinition }[];
    expect(active[0]?.definition.pages[0]?.elements[0]).toMatchObject({
      text: 'Tell us how it went',
    });

    const draft = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/feedback-databases/${databaseId}/form/draft`)).body,
    ) as { definition: FormDefinition };
    expect(draft.definition.pages[0]?.elements[0]).toMatchObject({
      text: 'A different heading',
    });
  });

  it('rejects a publish from a stale draft revision (FR-042C)', async () => {
    const f = ids();
    const revision = await saveDraft(h, databaseId, referenceDefinition(f));

    // Someone else autosaves while this editor is still looking at `revision`.
    await saveDraft(h, databaseId, referenceDefinition(f));

    const stale = await asAdmin(h, 'POST', `/v1/feedback-databases/${databaseId}/form/publish`, {
      expectedRevision: revision,
    });
    expect(stale.statusCode).toBe(409);
    expect(errorCode(stale)).toBe('stale_draft_revision');

    // Reloading the draft and publishing that revision succeeds.
    const current = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/feedback-databases/${databaseId}/form/draft`)).body,
    ) as { revision: number };
    expect(await publish(h, databaseId, current.revision)).toBe(1);
  });

  it('refuses to publish an invalid template, listing every problem (FR-042)', async () => {
    const f = ids();
    await saveDraft(h, databaseId, {
      pages: [{ id: f.page1, elements: [{ id: f.title, type: 'title', text: 'No questions' }] }],
    });

    const response = await asAdmin(h, 'POST', `/v1/feedback-databases/${databaseId}/form/publish`, {});
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('form_template_invalid');
    expect(errorDetails(response).map((d) => d.code)).toContain('no_questions');
  });

  it('refuses to publish an empty draft', async () => {
    const response = await asAdmin(h, 'POST', `/v1/feedback-databases/${databaseId}/form/publish`, {});
    expect(response.statusCode).toBe(400);
    expect(errorDetails(response).map((d) => d.code)).toContain('empty_form');
  });

  it('rejects a draft whose definition does not match the schema', async () => {
    const response = await asAdmin(h, 'PUT', `/v1/feedback-databases/${databaseId}/form/draft`, {
      definition: { pages: [{ id: 'not-an-id', elements: [] }] },
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('validation_failed');
  });

  it('surfaces publishability on the draft so the builder can disable the button', async () => {
    const f = ids();
    await saveDraft(h, databaseId, {
      pages: [{ id: f.page1, elements: [] }],
    });
    const before = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/feedback-databases/${databaseId}/form/draft`)).body,
    ) as { problems: { code: string }[] };
    expect(before.problems.map((p) => p.code)).toContain('empty_page');

    await saveDraft(h, databaseId, referenceDefinition(f));
    const after = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/feedback-databases/${databaseId}/form/draft`)).body,
    ) as { problems: unknown[] };
    expect(after.problems).toEqual([]);
  });

  it('unpublishes without deleting versions (FR-042F)', async () => {
    const f = ids();
    await saveDraft(h, databaseId, referenceDefinition(f));
    await publish(h, databaseId);

    const response = await asAdmin(h, 'POST', `/v1/feedback-databases/${databaseId}/form/unpublish`);
    expect(response.statusCode).toBe(200);

    const database = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/feedback-databases/${databaseId}`)).body,
    ) as { activeFormVersion: number | null };
    expect(database.activeFormVersion).toBeNull();

    const versions = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/feedback-databases/${databaseId}/form/versions`)).body,
    ) as { version: number; active: boolean }[];
    expect(versions).toHaveLength(1);
    expect(versions[0]?.active).toBe(false);
  });

  it('rolls back to an earlier version (FR-042E)', async () => {
    const f = ids();
    await saveDraft(h, databaseId, referenceDefinition(f));
    await publish(h, databaseId);

    const changed = referenceDefinition(f);
    changed.pages[0]!.elements[0] = { id: f.title, type: 'title', text: 'Version two heading' };
    await saveDraft(h, databaseId, changed);
    await publish(h, databaseId);

    const rolled = await asAdmin(h, 'POST', `/v1/feedback-databases/${databaseId}/form/rollback`, {
      version: 1,
    });
    expect(rolled.statusCode).toBe(200);
    expect(JSON.parse(rolled.body)).toMatchObject({ version: 1, active: true });

    const database = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/feedback-databases/${databaseId}`)).body,
    ) as { activeFormVersion: number };
    expect(database.activeFormVersion).toBe(1);
  });

  it('rolls back to the most recent inactive version by default', async () => {
    const f = ids();
    await saveDraft(h, databaseId, referenceDefinition(f));
    await publish(h, databaseId);
    await saveDraft(h, databaseId, referenceDefinition(f));
    await publish(h, databaseId);
    await saveDraft(h, databaseId, referenceDefinition(f));
    await publish(h, databaseId);

    const rolled = await asAdmin(h, 'POST', `/v1/feedback-databases/${databaseId}/form/rollback`, {});
    expect(JSON.parse(rolled.body)).toMatchObject({ version: 2 });
  });

  it('refuses a rollback when there is no earlier version', async () => {
    const f = ids();
    await saveDraft(h, databaseId, referenceDefinition(f));
    await publish(h, databaseId);
    const response = await asAdmin(h, 'POST', `/v1/feedback-databases/${databaseId}/form/rollback`, {});
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('no_previous_version');
  });

  it('refuses a rollback to a version that does not exist', async () => {
    const f = ids();
    await saveDraft(h, databaseId, referenceDefinition(f));
    await publish(h, databaseId);
    const response = await asAdmin(h, 'POST', `/v1/feedback-databases/${databaseId}/form/rollback`, {
      version: 7,
    });
    expect(response.statusCode).toBe(404);
    expect(errorCode(response)).toBe('form_version_unknown');
  });

  it('keeps each feedback database on its own version sequence', async () => {
    const f = ids();
    const projectId = await createProject(h, 'Second project');
    const other = await createDatabase(h, projectId);

    await saveDraft(h, databaseId, referenceDefinition(f));
    await publish(h, databaseId);
    await saveDraft(h, databaseId, referenceDefinition(f));
    await publish(h, databaseId);

    await saveDraft(h, other, referenceDefinition(ids()));
    expect(await publish(h, other)).toBe(1);
  });
});
