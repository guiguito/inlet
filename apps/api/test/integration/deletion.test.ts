import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  attachments,
  feedbackDatabases,
  formDrafts,
  formVersions,
  projectCredentials,
  projectMemberships,
  projects,
  storagePurgeQueue,
  submissionIntents,
  submissions,
} from '../../src/db/schema.js';
import { runPurgeBatch } from '../../src/services/purge.js';
import { createHarness, ids, referenceDefinition, type Harness } from '../setup/harness.js';
import {
  asAdmin,
  createIntent,
  errorCode,
  finalize,
  setupPublishedForm,
  uploadScreenshot,
  withKey,
} from '../setup/api.js';
import * as fixtures from '../setup/images.js';

/**
 * Destructive deletion and asynchronous purge (FR-024, FR-026, FR-027, section 12.3).
 */
describe('deleting feedback databases and projects', () => {
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

  /** One submission with a screenshot, plus an unreferenced pending upload. */
  async function populate(): Promise<{ attachmentId: string; pendingId: string }> {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const bound = JSON.parse(
      (
        await uploadScreenshot(
          h,
          ctx.publishableKey,
          ctx.databaseId,
          intent,
          f.shot,
          await fixtures.png(100, 60),
        )
      ).body,
    ) as { attachmentId: string };
    const pending = JSON.parse(
      (
        await uploadScreenshot(
          h,
          ctx.publishableKey,
          ctx.databaseId,
          intent,
          f.shot,
          await fixtures.png(80, 50),
        )
      ).body,
    ) as { attachmentId: string };

    await finalize(h, ctx.publishableKey, ctx.databaseId, intent, {
      formVersion: 1,
      answers: {
        [f.mood]: { optionId: f.moodOptions[0] },
        [f.detail]: { value: 'about to be deleted' },
        [f.shot]: { attachmentIds: [bound.attachmentId] },
      },
    });
    return { attachmentId: bound.attachmentId, pendingId: pending.attachmentId };
  }

  it('deletes a feedback database with everything it contains (FR-024)', async () => {
    const { attachmentId } = await populate();

    const response = await asAdmin(h, 'DELETE', `/v1/feedback-databases/${ctx.databaseId}`);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).deleted).toBe(true);

    expect(await h.ctx.db.select().from(feedbackDatabases)).toHaveLength(0);
    expect(await h.ctx.db.select().from(formDrafts)).toHaveLength(0);
    expect(await h.ctx.db.select().from(formVersions)).toHaveLength(0);
    expect(await h.ctx.db.select().from(submissions)).toHaveLength(0);
    expect(await h.ctx.db.select().from(submissionIntents)).toHaveLength(0);
    expect(await h.ctx.db.select().from(attachments)).toHaveLength(0);

    // The project and its credentials survive.
    expect(await h.ctx.db.select().from(projects)).toHaveLength(1);
    expect(await h.ctx.db.select().from(projectCredentials)).toHaveLength(2);

    // FR-027: reported complete immediately, and the asset is already unreachable.
    const asset = await withKey(h.app, ctx.secretKey, 'GET', `/v1/attachments/${attachmentId}`);
    expect(asset.statusCode).toBe(404);
  });

  it('queues the deleted objects and purges them asynchronously (FR-027)', async () => {
    const { attachmentId, pendingId } = await populate();
    const boundKey = `attachments/${attachmentId}.webp`;
    const pendingKey = `attachments/${pendingId}.webp`;

    expect(await h.ctx.storage.get(boundKey)).not.toBeNull();

    await asAdmin(h, 'DELETE', `/v1/feedback-databases/${ctx.databaseId}`);

    const queued = await h.ctx.db.select().from(storagePurgeQueue);
    // Both the bound attachment and the pending upload belonged to the database.
    expect(queued.map((row) => row.storageKey).sort()).toEqual([boundKey, pendingKey].sort());
    expect(queued.every((row) => row.status === 'pending')).toBe(true);

    expect(await runPurgeBatch(h.ctx)).toBe(2);
    expect(await h.ctx.db.select().from(storagePurgeQueue)).toHaveLength(0);
    expect(await h.ctx.storage.get(boundKey)).toBeNull();
    expect(await h.ctx.storage.get(pendingKey)).toBeNull();
  });

  it('does nothing and reports nothing to do when the purge queue is empty', async () => {
    expect(await runPurgeBatch(h.ctx)).toBe(0);
  });

  it('deletes a project with every feedback database it contains (FR-026)', async () => {
    await populate();
    const second = JSON.parse(
      (
        await asAdmin(h, 'POST', `/v1/projects/${ctx.projectId}/feedback-databases`, {
          name: 'Second',
        })
      ).body,
    ).id as string;

    const response = await asAdmin(h, 'DELETE', `/v1/projects/${ctx.projectId}`);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).purgedKeys).toBe(2);

    expect(await h.ctx.db.select().from(projects)).toHaveLength(0);
    expect(await h.ctx.db.select().from(projectMemberships)).toHaveLength(0);
    expect(await h.ctx.db.select().from(projectCredentials)).toHaveLength(0);
    expect(await h.ctx.db.select().from(feedbackDatabases)).toHaveLength(0);
    expect(await h.ctx.db.select().from(submissions)).toHaveLength(0);
    expect(await h.ctx.db.select().from(attachments)).toHaveLength(0);

    // Both databases are gone.
    expect((await asAdmin(h, 'GET', `/v1/feedback-databases/${second}`)).statusCode).toBe(404);

    // The project's credentials stop working immediately.
    const afterwards = await withKey(
      h.app,
      ctx.secretKey,
      'GET',
      `/v1/feedback-databases/${ctx.databaseId}`,
    );
    expect(afterwards.statusCode).toBe(401);
  });

  it('leaves other projects untouched', async () => {
    const other = await setupPublishedForm(h, referenceDefinition(ids()));
    await asAdmin(h, 'DELETE', `/v1/projects/${ctx.projectId}`);

    expect((await asAdmin(h, 'GET', `/v1/projects/${other.projectId}`)).statusCode).toBe(200);
    expect(
      (await withKey(h.app, other.secretKey, 'GET', `/v1/feedback-databases/${other.databaseId}`))
        .statusCode,
    ).toBe(200);
  });

  it('reports deleting an unknown project or database as missing', async () => {
    expect((await asAdmin(h, 'DELETE', '/v1/projects/prj_zzzzzzzzzzzz')).statusCode).toBe(404);
    expect(
      (await asAdmin(h, 'DELETE', '/v1/feedback-databases/fdb_zzzzzzzzzzzz')).statusCode,
    ).toBe(404);
  });

  it('lets a secret server key delete within its project, and no key outside it', async () => {
    const other = await setupPublishedForm(h, referenceDefinition(ids()));

    const foreign = await withKey(
      h.app,
      ctx.secretKey,
      'DELETE',
      `/v1/feedback-databases/${other.databaseId}`,
    );
    expect(foreign.statusCode).toBe(404);

    const own = await withKey(
      h.app,
      ctx.secretKey,
      'DELETE',
      `/v1/feedback-databases/${ctx.databaseId}`,
    );
    expect(own.statusCode).toBe(200);
  });

  it('refuses deletion to a publishable client key', async () => {
    const response = await withKey(
      h.app,
      ctx.publishableKey,
      'DELETE',
      `/v1/feedback-databases/${ctx.databaseId}`,
    );
    expect(response.statusCode).toBe(403);
    expect(errorCode(response)).toBe('insufficient_scope');
  });

  it('retries a failed purge with backoff rather than losing the key', async () => {
    await h.ctx.db.insert(storagePurgeQueue).values({ storageKey: 'attachments/never.webp' });

    // A storage that always fails, standing in for an outage.
    const broken = {
      ...h.ctx,
      storage: {
        ...h.ctx.storage,
        deleteMany: async () => {
          throw new Error('object store unavailable');
        },
      } as unknown as typeof h.ctx.storage,
    };

    expect(await runPurgeBatch(broken)).toBe(0);

    const rows = await h.ctx.db
      .select()
      .from(storagePurgeQueue)
      .where(eq(storagePurgeQueue.storageKey, 'attachments/never.webp'));
    expect(rows[0]?.attempts).toBe(1);
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.lastError).toContain('object store unavailable');
    expect(rows[0]?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });
});
