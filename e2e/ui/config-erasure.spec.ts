import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';

/**
 * Remote Config RC-100 inside the project's erasure (Foundations FD-033), in a browser against
 * the running server: a user ID written into a config database's beta rule, published; a project
 * Admin previews and erases it from the project's settings, sees the config database's counts
 * under its own label, and the fetch for that user no longer receives the beta value.
 */

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(E2E.adminEmail);
  await page.getByLabel('Password').fill(E2E.adminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
}

test('a project Admin erases a user ID named in a config rule from the project’s settings', async ({ page, request }) => {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `Config erasure ${Date.now()}` } })).json()).id as string;
  const key = (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'app' } })).json()).secret as string;
  const configId = (await (await request.post(`/v1/projects/${projectId}/config-databases`, { data: { name: 'Mobile config' } })).json()).id as string;
  const userId = `erase-${randomUUID().slice(0, 8)}`;
  const template = {
    parameters: [{ key: 'new_checkout', type: 'boolean', default: false, conditional: [{ condition: 'cnd_beta', value: true }] }],
    conditions: [{ id: 'cnd_beta', name: 'Beta testers', kind: 'match', rules: [{ attribute: 'userId', operator: 'in', value: [userId, 'someone-else'] }] }],
  };
  const saved = await request.put(`/v1/config-databases/${configId}/draft`, { data: { template } });
  expect(saved.status()).toBe(200);
  expect((await request.post(`/v1/config-databases/${configId}/publish`, { data: { revision: (await saved.json()).revision } })).status()).toBe(201);
  const fetchValues = async () => {
    const answer = await request.post(`/v1/config-databases/${configId}/fetch`, { headers: { authorization: `Bearer ${key}` }, data: { userId } });
    expect(answer.status()).toBe(200);
    return (await answer.json()).values;
  };
  expect(await fetchValues()).toEqual({ new_checkout: true });

  await signIn(page);
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: 'Settings' }).click();
  const panel = page.getByTestId('erase-panel');
  await panel.getByLabel('ID').fill(userId);
  await panel.getByRole('button', { name: 'Preview' }).click();

  const preview = panel.getByTestId('erase-preview');
  const row = preview.getByRole('row', { name: /Mobile config/ });
  await expect(row).toContainText('Config');
  await expect(row).toContainText('1 rule in the draft and 1 rule across the versions name the ID');
  await expect(preview).toContainText('holds no installation or user ID from a fetch');
  await preview.getByLabel('Erase in Mobile config').check();
  await preview.getByLabel(`Type ${userId} to confirm`).fill(userId);
  await preview.getByRole('button', { name: 'Erase in 1 database' }).click();

  await expect(panel.getByTestId('erase-result')).toContainText('Mobile config: the ID removed from 1 rule in the draft and 1 rule across the versions');
  // The active version is served rewritten at once.
  expect(await fetchValues()).toEqual({ new_checkout: false });
  expect((await (await request.get(`/v1/config-databases/${configId}`)).json()).activeVersion).toBe(1);
});

test('the preview lists a config database beside the others, and says what a config database holds only when it lists one', async ({ page, request }) => {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const mixed = (await (await request.post('/v1/projects', { data: { name: `Mixed erasure ${Date.now()}` } })).json()).id as string;
  expect((await request.post(`/v1/projects/${mixed}/feedback-databases`, { data: { name: 'Checkout feedback' } })).status()).toBe(201);
  expect((await request.post(`/v1/projects/${mixed}/config-databases`, { data: { name: 'Web config' } })).status()).toBe(201);
  const none = (await (await request.post('/v1/projects', { data: { name: `No config ${Date.now()}` } })).json()).id as string;
  expect((await request.post(`/v1/projects/${none}/feedback-databases`, { data: { name: 'Only feedback' } })).status()).toBe(201);

  await signIn(page);
  const previewIn = async (projectId: string) => {
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('tab', { name: 'Settings' }).click();
    const panel = page.getByTestId('erase-panel');
    await panel.getByLabel('ID').fill('nobody-at-all');
    await panel.getByRole('button', { name: 'Preview' }).click();
    return panel.getByTestId('erase-preview');
  };
  let preview = await previewIn(mixed);
  await expect(preview.getByRole('row', { name: /Checkout feedback/ })).toContainText('0 submissions, 0 screenshots');
  await expect(preview.getByRole('row', { name: /Web config/ })).toContainText('0 rules in the draft and 0 rules across the versions name the ID');
  await expect(preview).toContainText('holds no installation or user ID from a fetch');

  preview = await previewIn(none);
  await expect(preview.getByRole('row', { name: /Only feedback/ })).toBeVisible();
  await expect(preview).not.toContainText('holds no installation or user ID from a fetch');
});
