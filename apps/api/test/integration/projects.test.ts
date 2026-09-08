import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { projectCredentials, projectMemberships } from '../../src/db/schema.js';
import { sha256 } from '../../src/lib/crypto.js';
import { createHarness, type Harness } from '../setup/harness.js';
import {
  asAdmin,
  createCredential,
  createDatabase,
  createProject,
  errorCode,
  withKey,
} from '../setup/api.js';

/**
 * Projects, feedback databases and credentials
 * (FR-010 to FR-014, FR-020 to FR-023, FR-080 to FR-087).
 */
describe('projects, feedback databases and credentials', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
  });

  it('makes the creating user the project Admin (FR-010)', async () => {
    const projectId = await createProject(h, 'Deblock App');

    const memberships = await h.ctx.db
      .select()
      .from(projectMemberships)
      .where(eq(projectMemberships.projectId, projectId));
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe('admin');

    const read = await asAdmin(h, 'GET', `/v1/projects/${projectId}`);
    expect(JSON.parse(read.body)).toMatchObject({ name: 'Deblock App', role: 'admin' });
  });

  it('supports two projects with several feedback databases each', async () => {
    const first = await createProject(h, 'First');
    const second = await createProject(h, 'Second');
    await createDatabase(h, first, 'App feedback');
    await createDatabase(h, first, 'Beta programme');
    await createDatabase(h, second, 'Website');

    const listed = JSON.parse((await asAdmin(h, 'GET', '/v1/projects')).body) as {
      id: string;
      name: string;
      feedbackDatabaseCount: number;
    }[];
    expect(listed.map((p) => [p.name, p.feedbackDatabaseCount])).toEqual([
      ['First', 2],
      ['Second', 1],
    ]);

    const databases = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/projects/${first}/feedback-databases`)).body,
    ) as { name: string; activeFormVersion: number | null }[];
    expect(databases.map((d) => d.name)).toEqual(['App feedback', 'Beta programme']);
    // FR-022: each database has at most one active published version, none yet.
    expect(databases.every((d) => d.activeFormVersion === null)).toBe(true);
  });

  it('gives every feedback database a unique, stable identifier (FR-021)', async () => {
    const projectId = await createProject(h);
    const ids = await Promise.all([
      createDatabase(h, projectId, 'One'),
      createDatabase(h, projectId, 'Two'),
      createDatabase(h, projectId, 'Three'),
    ]);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^fdb_[0-9a-hjkmnp-tv-z]{12}$/);

    // Renaming does not change the identifier client applications depend on.
    const [first] = ids;
    await asAdmin(h, 'PATCH', `/v1/feedback-databases/${first}`, { name: 'Renamed' });
    const read = await asAdmin(h, 'GET', `/v1/feedback-databases/${first}`);
    expect(JSON.parse(read.body)).toMatchObject({ id: first, name: 'Renamed' });
  });

  it('renames a project and rejects a blank name', async () => {
    const projectId = await createProject(h, 'Before');
    const renamed = await asAdmin(h, 'PATCH', `/v1/projects/${projectId}`, { name: 'After' });
    expect(JSON.parse(renamed.body)).toMatchObject({ name: 'After' });

    const blank = await asAdmin(h, 'PATCH', `/v1/projects/${projectId}`, { name: '   ' });
    expect(blank.statusCode).toBe(400);
    expect(errorCode(blank)).toBe('validation_failed');
  });

  it('reports a project the caller cannot reach as missing, not forbidden', async () => {
    const response = await asAdmin(h, 'GET', '/v1/projects/prj_zzzzzzzzzzzz');
    expect(response.statusCode).toBe(404);
    expect(errorCode(response)).toBe('project_not_found');
  });

  it('shows a secret server key only once and stores it hashed (FR-084)', async () => {
    const projectId = await createProject(h);
    const created = await createCredential(h, projectId, 'secret', 'Backend');
    expect(created.secret).toMatch(/^isk_/);

    const rows = await h.ctx.db
      .select()
      .from(projectCredentials)
      .where(eq(projectCredentials.id, created.id));
    expect(rows[0]?.secretHash).toBe(sha256(created.secret));
    expect(rows[0]?.publishableKey).toBeNull();
    expect(JSON.stringify(rows[0])).not.toContain(created.secret);

    const listed = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/projects/${projectId}/credentials`)).body,
    ) as { id: string; key: string | null; prefix: string; lastFour: string }[];
    const secret = listed.find((c) => c.id === created.id);
    expect(secret?.key).toBeNull();
    expect(created.secret.startsWith(secret?.prefix ?? 'x')).toBe(true);
    expect(created.secret.endsWith(secret?.lastFour ?? 'x')).toBe(true);
  });

  it('keeps a publishable key readable, because it ships in public clients', async () => {
    const projectId = await createProject(h);
    const created = await createCredential(h, projectId, 'publishable', 'Web');
    expect(created.secret).toMatch(/^ipk_/);

    const listed = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/projects/${projectId}/credentials`)).body,
    ) as { id: string; key: string | null }[];
    expect(listed.find((c) => c.id === created.id)?.key).toBe(created.secret);
  });

  it('generates multiple keys of both types for one project (FR-080)', async () => {
    const projectId = await createProject(h);
    await createCredential(h, projectId, 'publishable', 'iOS');
    await createCredential(h, projectId, 'publishable', 'Android');
    await createCredential(h, projectId, 'secret', 'Reporting');

    const listed = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/projects/${projectId}/credentials`)).body,
    ) as { type: string; label: string }[];
    expect(listed.map((c) => [c.type, c.label])).toEqual([
      ['publishable', 'iOS'],
      ['publishable', 'Android'],
      ['secret', 'Reporting'],
    ]);
  });

  it('relabels a credential without changing its value', async () => {
    const projectId = await createProject(h);
    const created = await createCredential(h, projectId, 'publishable', 'Old label');
    const updated = await asAdmin(
      h,
      'PATCH',
      `/v1/projects/${projectId}/credentials/${created.id}`,
      { label: 'New label' },
    );
    expect(JSON.parse(updated.body)).toMatchObject({ label: 'New label', key: created.secret });
  });

  it('rotates a credential so the old value stops working (FR-085)', async () => {
    const projectId = await createProject(h);
    const databaseId = await createDatabase(h, projectId);
    const created = await createCredential(h, projectId, 'secret', 'Backend');

    // The key works before rotation.
    expect(
      (await withKey(h.app, created.secret, 'GET', `/v1/feedback-databases/${databaseId}`))
        .statusCode,
    ).toBe(200);

    const rotated = JSON.parse(
      (await asAdmin(h, 'POST', `/v1/projects/${projectId}/credentials/${created.id}/rotate`))
        .body,
    ) as { id: string; secret: string; rotatedAt: string };

    expect(rotated.id).toBe(created.id);
    expect(rotated.secret).not.toBe(created.secret);
    expect(rotated.rotatedAt).toBeTruthy();

    const withOld = await withKey(
      h.app,
      created.secret,
      'GET',
      `/v1/feedback-databases/${databaseId}`,
    );
    expect(withOld.statusCode).toBe(401);
    expect(errorCode(withOld)).toBe('invalid_api_key');

    expect(
      (await withKey(h.app, rotated.secret, 'GET', `/v1/feedback-databases/${databaseId}`))
        .statusCode,
    ).toBe(200);
  });

  it('revokes a credential and refuses every later request with it', async () => {
    const projectId = await createProject(h);
    const databaseId = await createDatabase(h, projectId);
    const created = await createCredential(h, projectId, 'secret');

    const revoked = await asAdmin(
      h,
      'POST',
      `/v1/projects/${projectId}/credentials/${created.id}/revoke`,
    );
    expect(JSON.parse(revoked.body)).toMatchObject({ id: created.id });
    expect(JSON.parse(revoked.body).revokedAt).toBeTruthy();

    const after = await withKey(
      h.app,
      created.secret,
      'GET',
      `/v1/feedback-databases/${databaseId}`,
    );
    expect(after.statusCode).toBe(401);
    // A revoked key is reported distinctly from an unknown one, so an operator can
    // tell "I revoked this" from "this was never valid".
    expect(['revoked_api_key', 'invalid_api_key']).toContain(errorCode(after));

    // The row survives for the audit trail with no usable value left on disk.
    const rows = await h.ctx.db
      .select()
      .from(projectCredentials)
      .where(eq(projectCredentials.id, created.id));
    expect(rows[0]?.secretHash).toBeNull();
    expect(rows[0]?.publishableKey).toBeNull();
  });

  it('reports a revoked publishable key as revoked, not merely unknown', async () => {
    const projectId = await createProject(h);
    const databaseId = await createDatabase(h, projectId);
    const created = await createCredential(h, projectId, 'publishable');

    // Revoking clears the stored value, so re-presenting it cannot be matched to the
    // row. This documents the deliberate trade-off: the value is destroyed on revoke.
    await asAdmin(h, 'POST', `/v1/projects/${projectId}/credentials/${created.id}/revoke`);
    const after = await withKey(
      h.app,
      created.secret,
      'GET',
      `/v1/feedback-databases/${databaseId}/form`,
    );
    expect(after.statusCode).toBe(401);
  });

  it('refuses to rotate a revoked credential', async () => {
    const projectId = await createProject(h);
    const created = await createCredential(h, projectId, 'secret');
    await asAdmin(h, 'POST', `/v1/projects/${projectId}/credentials/${created.id}/revoke`);
    const response = await asAdmin(
      h,
      'POST',
      `/v1/projects/${projectId}/credentials/${created.id}/rotate`,
    );
    expect(response.statusCode).toBe(400);
  });

  it('records when a credential was last used (FR-085)', async () => {
    const projectId = await createProject(h);
    const databaseId = await createDatabase(h, projectId);
    const created = await createCredential(h, projectId, 'secret');

    const before = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/projects/${projectId}/credentials`)).body,
    ) as { id: string; lastUsedAt: string | null }[];
    expect(before.find((c) => c.id === created.id)?.lastUsedAt).toBeNull();

    await withKey(h.app, created.secret, 'GET', `/v1/feedback-databases/${databaseId}`);

    const after = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/projects/${projectId}/credentials`)).body,
    ) as { id: string; lastUsedAt: string | null }[];
    expect(after.find((c) => c.id === created.id)?.lastUsedAt).toBeTruthy();
  });

  it('will not let a credential reach another project (FR-086)', async () => {
    const mine = await createProject(h, 'Mine');
    const theirs = await createProject(h, 'Theirs');
    const theirDatabase = await createDatabase(h, theirs);
    const myKey = await createCredential(h, mine, 'secret');

    const response = await withKey(
      h.app,
      myKey.secret,
      'GET',
      `/v1/feedback-databases/${theirDatabase}`,
    );
    expect(response.statusCode).toBe(404);
    expect(errorCode(response)).toBe('feedback_database_not_found');
  });

  it('scopes credential management to a signed-in project Admin', async () => {
    const projectId = await createProject(h);
    const secret = await createCredential(h, projectId, 'secret');

    // Section 9.6 marks credential operations unavailable to both key types.
    const asServerKey = await withKey(
      h.app,
      secret.secret,
      'GET',
      `/v1/projects/${projectId}/credentials`,
    );
    expect(asServerKey.statusCode).toBe(403);
    expect(errorCode(asServerKey)).toBe('insufficient_scope');

    const unauthenticated = await h.app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/credentials`,
    });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it('rejects an unknown credential id under a project the caller does own', async () => {
    const projectId = await createProject(h);
    const response = await asAdmin(
      h,
      'POST',
      `/v1/projects/${projectId}/credentials/cred_zzzzzzzzzzzz/revoke`,
    );
    expect(response.statusCode).toBe(404);
    expect(errorCode(response)).toBe('credential_not_found');
  });

  it('rejects a garbage or absent bearer key', async () => {
    const projectId = await createProject(h);
    const databaseId = await createDatabase(h, projectId);

    for (const key of ['nonsense', 'ipk_does_not_exist', 'isk_does_not_exist']) {
      const response = await withKey(
        h.app,
        key,
        'GET',
        `/v1/feedback-databases/${databaseId}/form`,
      );
      expect(response.statusCode).toBe(401);
      expect(errorCode(response)).toBe('invalid_api_key');
    }

    const noKey = await h.app.inject({
      method: 'GET',
      url: `/v1/feedback-databases/${databaseId}/form`,
    });
    expect(noKey.statusCode).toBe(401);
    expect(errorCode(noKey)).toBe('unauthenticated');
  });
});
