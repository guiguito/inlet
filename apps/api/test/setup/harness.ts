import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { newId, type FormDefinition } from '@inlet/shared';
import { buildApp } from '../../src/app.js';
import type { AppContext } from '../../src/context.js';
import { createDb, type DbHandle } from '../../src/db/index.js';
import { loadEnv } from '../../src/env.js';
import { MalwareScanner } from '../../src/lib/malware.js';
import { Storage } from '../../src/lib/storage.js';
import { bootstrapAdmin } from '../../src/services/bootstrap.js';
import { ADMIN_EMAIL, ADMIN_PASSWORD, TEST_ENV } from './config.js';

/**
 * One harness for every integration test: a real app, a real database, real object
 * storage, and helpers for the setup each test would otherwise repeat.
 */

export type Harness = {
  app: FastifyInstance;
  ctx: AppContext;
  handle: DbHandle;
  /** Session cookie for the bootstrapped Admin. */
  cookie: string;
  reset: () => Promise<void>;
  close: () => Promise<void>;
};

const TABLES = [
  'storage_purge_queue',
  'attachments',
  'submissions',
  'submission_intents',
  'hosted_forms',
  'form_versions',
  'form_drafts',
  'invitations',
  'project_credentials',
  'feedback_database_memberships',
  'feedback_databases',
  'project_memberships',
  'projects',
  'sessions',
  'users',
];

export async function createHarness(overrides: Record<string, string> = {}): Promise<Harness> {
  const env = loadEnv({ ...process.env, ...TEST_ENV, ...overrides });
  const handle = createDb(env.INLET_DATABASE_URL);
  const storage = new Storage(env);
  const scanner = new MalwareScanner(env);
  const ctx: AppContext = {
    env,
    db: handle.db,
    storage,
    scanner,
    log: pino({ level: 'silent' }),
  };

  await storage.ensureBucket(true);
  await storage.ensureLifecycleRule();

  const app = await buildApp(ctx);
  await app.ready();

  const harness: Harness = {
    app,
    ctx,
    handle,
    cookie: '',
    reset: async () => {
      await handle.db.execute(sql.raw(`truncate table ${TABLES.join(', ')} cascade`));
      await bootstrapAdmin(ctx);
      harness.cookie = await signIn(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    },
    close: async () => {
      await app.close();
      storage.destroy();
      await handle.pool.end();
    },
  };

  await harness.reset();
  return harness;
}

export async function signIn(
  app: FastifyInstance,
  email: string,
  password: string,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/sign-in',
    payload: { email, password },
  });
  if (response.statusCode !== 200) {
    throw new Error(`sign-in failed: ${response.statusCode} ${response.body}`);
  }
  const setCookie = response.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!raw) throw new Error('sign-in returned no session cookie');
  return raw.split(';')[0] ?? '';
}

// --- Fixtures ---------------------------------------------------------------

/** Stable IDs so a test can name the question it is asserting about. */
export function ids() {
  return {
    page1: newId('page'),
    page2: newId('page'),
    title: newId('element'),
    intro: newId('element'),
    mood: newId('element'),
    areas: newId('element'),
    detail: newId('element'),
    email: newId('element'),
    shot: newId('element'),
    moodOptions: [newId('option'), newId('option'), newId('option')] as const,
    areaOptions: [newId('option'), newId('option'), newId('option')] as const,
  };
}

export type Fixture = ReturnType<typeof ids>;

/**
 * The reference form: two pages, content between questions, emoji single-select,
 * text multi-select, a required multi-line free-text question with a placeholder, an
 * optional email question, and an optional screenshot question.
 *
 * This is the template the acceptance criteria of section 14 describe.
 */
export function referenceDefinition(f: Fixture): FormDefinition {
  return {
    pages: [
      {
        id: f.page1,
        elements: [
          { id: f.title, type: 'title', text: 'Tell us how it went' },
          { id: f.intro, type: 'body_text', text: 'Two short pages, nothing shared outside the team.' },
          {
            id: f.mood,
            type: 'choice',
            label: 'How do you feel about the app?',
            required: true,
            optionKind: 'emoji',
            selection: 'single',
            orientation: 'horizontal',
            options: [
              { id: f.moodOptions[0], label: 'Love it', emoji: '😍' },
              { id: f.moodOptions[1], label: 'Fine', emoji: '🙂' },
              { id: f.moodOptions[2], label: 'Broken', emoji: '😡' },
            ],
          },
          {
            id: f.areas,
            type: 'choice',
            label: 'Which areas did you use?',
            required: false,
            optionKind: 'text',
            selection: 'multi',
            orientation: 'vertical',
            options: [
              { id: f.areaOptions[0], label: 'Payments' },
              { id: f.areaOptions[1], label: 'Cards' },
              { id: f.areaOptions[2], label: 'Support' },
            ],
          },
        ],
      },
      {
        id: f.page2,
        elements: [
          {
            id: f.detail,
            type: 'text',
            label: 'What should we fix first?',
            required: true,
            multiline: true,
            maxLength: 500,
            placeholder: 'Start typing…',
          },
          {
            id: f.email,
            type: 'email',
            label: 'Email for follow-up',
            required: false,
            helperText: 'Only used to reply to this feedback.',
          },
          {
            id: f.shot,
            type: 'screenshot',
            label: 'Attach a screenshot',
            required: false,
            maxCount: 3,
          },
        ],
      },
    ],
  };
}

/** A valid, minimal answer set for the reference form. */
export function referenceAnswers(f: Fixture) {
  return {
    [f.mood]: { optionId: f.moodOptions[0] },
    [f.detail]: { value: 'The card freeze toggle takes three taps.' },
  };
}
