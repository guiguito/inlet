import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { E2E } from '../env';

/**
 * The team flows in a browser (journey 7.4, FR-014, FR-070 to FR-074).
 *
 * The invitee is driven in a separate browser context throughout, because an
 * invitation redeemed from a signed-in session attaches to that session's account.
 * Sharing one context would test the wrong thing.
 */

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
}

const operator = (page: Page) => signIn(page, E2E.adminEmail, E2E.adminPassword);

/** A fresh browser context, so the invitee has no session of their own. */
async function newVisitor(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  return { page, close: () => context.close() };
}

async function apiFixture(request: APIRequestContext, name: string) {
  await request.post('/v1/auth/sign-in', {
    data: { email: E2E.adminEmail, password: E2E.adminPassword },
  });
  const project = await request.post('/v1/projects', { data: { name } });
  const projectId = (await project.json()).id as string;
  const database = await request.post(`/v1/projects/${projectId}/feedback-databases`, {
    data: { name: `${name} feedback` },
  });
  return { projectId, databaseId: (await database.json()).id as string };
}

test.describe('inviting a teammate', () => {
  test('invites, redeems and lands the new member inside the product', async ({
    page,
    browser,
  }) => {
    test.slow();
    await operator(page);

    // --- Create a project and invite a Creator ------------------------------
    await page.getByRole('button', { name: /New project|Create your first project/ }).first().click();
    await page.getByLabel('Name').fill('Team project');
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByRole('link', { name: /Team project/ }).click();
    await expect(page.getByRole('heading', { name: 'Team project' })).toBeVisible();

    await page.getByRole('tab', { name: 'Access' }).click();
    await expect(page.getByText('No invitations yet')).toBeVisible();

    await page.getByTestId('invite-member').click();
    // Scoped to the dialog: the member rows carry a Role control of their own.
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Role').click();
    await page.getByRole('option', { name: 'creator' }).click();
    await dialog.getByRole('button', { name: 'Create the link' }).click();

    const linkField = page.locator('code').filter({ hasText: '/invitations/' }).first();
    await expect(linkField).toBeVisible();
    const url = (await linkField.textContent())?.trim() ?? '';
    expect(url).toContain('/invitations/');
    await page.getByRole('button', { name: 'Done' }).click();

    // The invitation is listed as waiting.
    await expect(page.getByRole('cell', { name: /Waiting/ })).toBeVisible();

    // --- The invitee opens the link in their own browser --------------------
    const visitor = await newVisitor(browser);
    try {
      const path = new URL(url).pathname;
      await visitor.page.goto(path);

      // They see what they are accepting before accepting it.
      await expect(visitor.page.getByRole('heading', { name: 'You have been invited' })).toBeVisible();
      await expect(visitor.page.getByText('creator')).toBeVisible();
      await expect(visitor.page.getByText('Team project')).toBeVisible();

      const email = `teammate-${Date.now()}@example.com`;
      await visitor.page.getByLabel('Email').fill(email);
      await visitor.page.getByLabel('Password').fill('a-long-enough-password');
      await visitor.page.getByLabel('Name').fill('Robin');
      await visitor.page.getByTestId('accept-invitation').click();

      // They land on the projects list, already signed in, with the project visible.
      await expect(visitor.page.getByRole('heading', { name: 'Projects' })).toBeVisible();
      await expect(visitor.page.getByRole('link', { name: /Team project/ })).toBeVisible();

      // A Creator sees who has access but cannot change it (FR-073).
      await visitor.page.getByRole('link', { name: /Team project/ }).click();
      await expect(visitor.page.getByRole('tab', { name: 'Databases' })).toBeVisible();
      await visitor.page.getByRole('tab', { name: 'Access' }).click();

      await expect(visitor.page.getByTestId(`member-${email}`)).toBeVisible();
      await expect(visitor.page.getByTestId('invite-member')).toHaveCount(0);
      await expect(visitor.page.getByText(/managed by an Admin/)).toBeVisible();
      for (const row of await visitor.page.getByLabel('Role').all()) {
        await expect(row).toBeDisabled();
      }

      // --- The link is single-use ------------------------------------------
      const second = await newVisitor(browser);
      try {
        await second.page.goto(path);
        await expect(second.page.getByRole('heading', { name: 'This link does not work' })).toBeVisible();
        await expect(second.page.getByText(/already been used/)).toBeVisible();
      } finally {
        await second.close();
      }

      // --- The operator sees them as a member ------------------------------
      await page.reload();
      await page.getByRole('tab', { name: 'Access' }).click();
      await expect(page.getByTestId(`member-${email}`)).toBeVisible();
      await expect(page.getByTestId(`member-${email}`)).toContainText('Robin');
      await expect(page.getByRole('cell', { name: /Accepted/ })).toBeVisible();
    } finally {
      await visitor.close();
    }
  });

  test('shows a revoked link as unusable', async ({ page, browser, request }) => {
    await operator(page);
    const f = await apiFixture(request, 'Withdrawn access');

    const invitation = await request.post(`/v1/projects/${f.projectId}/invitations`, {
      data: { role: 'viewer' },
    });
    const { token } = (await invitation.json()) as { token: string };

    await page.goto(`/projects/${f.projectId}`);
    await page.getByRole('tab', { name: 'Access' }).click();
    await page.getByRole('button', { name: 'Revoke this invitation' }).click();
    await expect(page.getByRole('cell', { name: 'Revoked' })).toBeVisible();

    const visitor = await newVisitor(browser);
    try {
      await visitor.page.goto(`/invitations/${token}`);
      await expect(visitor.page.getByRole('heading', { name: 'This link does not work' })).toBeVisible();
      await expect(visitor.page.getByText(/revoked/)).toBeVisible();
    } finally {
      await visitor.close();
    }
  });

  test('reports a link that was never valid', async ({ browser }) => {
    const visitor = await newVisitor(browser);
    try {
      await visitor.page.goto('/invitations/not-a-real-token');
      await expect(visitor.page.getByRole('heading', { name: 'This link does not work' })).toBeVisible();
      await expect(visitor.page.getByText(/Ask whoever invited you/)).toBeVisible();
    } finally {
      await visitor.close();
    }
  });
});

test.describe('managing roles', () => {
  /** Invites and redeems over the API, returning the new member's email. */
  async function addMember(
    request: APIRequestContext,
    browser: Browser,
    scopePath: string,
    role: string,
  ): Promise<{ email: string; userId: string }> {
    const invitation = await request.post(`${scopePath}/invitations`, { data: { role } });
    const { token } = (await invitation.json()) as { token: string };

    const email = `member-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
    const visitor = await browser.newContext();
    try {
      const redeemed = await visitor.request.post(`/v1/invitations/${token}/redeem`, {
        data: { email, password: 'a-long-enough-password' },
      });
      expect(redeemed.status()).toBe(200);
      return { email, userId: (await redeemed.json()).id as string };
    } finally {
      await visitor.close();
    }
  }

  test('changes a project role from the interface', async ({ page, browser, request }) => {
    await operator(page);
    const f = await apiFixture(request, 'Role changes');
    const member = await addMember(request, browser, `/v1/projects/${f.projectId}`, 'viewer');

    await page.goto(`/projects/${f.projectId}`);
    await page.getByRole('tab', { name: 'Access' }).click();

    const row = page.getByTestId(`member-${member.email}`);
    await expect(row).toBeVisible();
    await row.getByLabel('Role').click();
    await page.getByRole('option', { name: 'creator' }).click();
    await expect(page.getByText('Access updated.')).toBeVisible();

    await page.reload();
    await page.getByRole('tab', { name: 'Access' }).click();
    await expect(page.getByTestId(`member-${member.email}`).getByLabel('Role')).toContainText(
      'creator',
    );
  });

  test('will not let the last Admin be downgraded or removed (FR-014)', async ({
    page,
    request,
  }) => {
    await operator(page);
    const f = await apiFixture(request, 'Last admin');

    await page.goto(`/projects/${f.projectId}`);
    await page.getByRole('tab', { name: 'Access' }).click();

    const row = page.getByTestId(`member-${E2E.adminEmail}`);
    await expect(row).toBeVisible();
    // The control is disabled rather than letting the attempt fail server-side.
    await expect(row.getByLabel('Role')).toBeDisabled();
    await expect(row.getByRole('button', { name: /Remove/ })).toHaveCount(0);
  });

  test('overrides a project role on one feedback database, and clears it again', async ({
    page,
    browser,
    request,
  }) => {
    await operator(page);
    const f = await apiFixture(request, 'Overrides');
    const member = await addMember(request, browser, `/v1/projects/${f.projectId}`, 'creator');

    await page.goto(`/databases/${f.databaseId}?tab=access`);
    const row = page.getByTestId(`member-${member.email}`);
    await expect(row).toBeVisible();
    // Inherited from the project to begin with.
    await expect(row).toContainText('Project');

    await row.getByLabel('Role').click();
    await page.getByRole('option', { name: 'viewer' }).click();
    await expect(page.getByText('Access updated.')).toBeVisible();

    await page.reload();
    const assigned = page.getByTestId(`member-${member.email}`);
    await expect(assigned).toContainText('Assigned');
    await expect(assigned.getByLabel('Role')).toContainText('viewer');

    // Clearing it returns them to the project role.
    await assigned.getByRole('button', { name: /Clear the assignment/ }).click();
    await page.getByRole('button', { name: 'Clear assignment' }).click();
    await expect(page.getByText('Assignment cleared.')).toBeVisible();

    await page.reload();
    await expect(page.getByTestId(`member-${member.email}`)).toContainText('Project');
  });

  test('shows a project Admin on a feedback database as unnarrowable (FR-071A)', async ({
    page,
    browser,
    request,
  }) => {
    await operator(page);
    const f = await apiFixture(request, 'Admin everywhere');
    const admin = await addMember(request, browser, `/v1/projects/${f.projectId}`, 'admin');

    await page.goto(`/databases/${f.databaseId}?tab=access`);
    const row = page.getByTestId(`member-${admin.email}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText('Project');

    // The API refuses to narrow them, and the interface reports the refusal.
    await row.getByLabel('Role').click();
    await page.getByRole('option', { name: 'viewer' }).click();
    await expect(page.getByText(/cannot be narrowed/)).toBeVisible();

    await page.reload();
    await expect(page.getByTestId(`member-${admin.email}`).getByLabel('Role')).toContainText(
      'admin',
    );
  });

  test('removes a member, and they lose the project', async ({ page, browser, request }) => {
    await operator(page);
    const f = await apiFixture(request, 'Removal');
    const member = await addMember(request, browser, `/v1/projects/${f.projectId}`, 'creator');

    await page.goto(`/projects/${f.projectId}`);
    await page.getByRole('tab', { name: 'Access' }).click();

    await page
      .getByTestId(`member-${member.email}`)
      .getByRole('button', { name: /Remove .* from the project/ })
      .click();
    await expect(page.getByText(/lose access to every feedback database/)).toBeVisible();
    await page.getByRole('button', { name: 'Remove from project' }).click();
    await expect(page.getByText('Removed from the project.')).toBeVisible();

    await page.reload();
    await page.getByRole('tab', { name: 'Access' }).click();
    await expect(page.getByTestId(`member-${member.email}`)).toHaveCount(0);

    // Their account still works; they simply see nothing here.
    const visitor = await newVisitor(browser);
    try {
      await signIn(visitor.page, member.email, 'a-long-enough-password');
      await expect(visitor.page.getByText('No projects yet')).toBeVisible();
    } finally {
      await visitor.close();
    }
  });

  test('scopes a feedback-database invitation to that database alone', async ({
    page,
    browser,
    request,
  }) => {
    await operator(page);
    const f = await apiFixture(request, 'Scoped access');
    const member = await addMember(
      request,
      browser,
      `/v1/feedback-databases/${f.databaseId}`,
      'viewer',
    );

    // Listed on the database, absent from the project.
    await page.goto(`/databases/${f.databaseId}?tab=access`);
    await expect(page.getByTestId(`member-${member.email}`)).toContainText('Assigned');

    await page.goto(`/projects/${f.projectId}`);
    await page.getByRole('tab', { name: 'Access' }).click();
    await expect(page.getByTestId(`member-${member.email}`)).toHaveCount(0);

    // And they reach the database without reaching the project.
    const visitor = await newVisitor(browser);
    try {
      await signIn(visitor.page, member.email, 'a-long-enough-password');
      await expect(visitor.page.getByText('No projects yet')).toBeVisible();

      await visitor.page.goto(`/databases/${f.databaseId}`);
      await expect(visitor.page.getByRole('tab', { name: 'Responses' })).toBeVisible();
    } finally {
      await visitor.close();
    }
  });
});
