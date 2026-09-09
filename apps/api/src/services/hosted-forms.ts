import { and, eq, ne } from 'drizzle-orm';
import {
  BRANDING_LIMITS,
  brandingVariables,
  isReservedSlug,
  newId,
  toClientDefinition,
  type ClientFormDefinition,
  type ColorScheme,
  type CornerRadius,
  type EmbeddingMode,
  type Typeface,
} from '@inlet/shared';
import type { AppContext } from '../context.js';
import {
  feedbackDatabases,
  hostedForms,
  type FeedbackDatabaseRow,
  type HostedFormRow,
} from '../db/schema.js';
import { apiError, errors } from '../lib/errors.js';
import { processImage } from '../lib/images.js';
import { getVersionById } from './forms.js';

/**
 * Hosted forms (FR-130 to FR-154).
 *
 * A hosted form is a second way to collect, beside the client API, not a replacement
 * for it. It introduces no second path to a stored submission: the public routes
 * resolve a slug to a feedback database and then call exactly the same intent,
 * validation and attachment services the API-key flow calls. A submission carries no
 * marker of having arrived through a link, which is why one looks identical in the
 * responses view whichever way it came in.
 */

/** The slug the platform generates. Short enough to paste, long enough to be unguessable. */
function generateSlug(): string {
  // newId gives a prefixed identifier; the slug wants only the body, because the
  // prefix would be noise in a URL people read aloud.
  return newId('feedbackDatabase').split('_')[1] ?? newId('feedbackDatabase');
}

/**
 * Reads the hosted form, creating a disabled one with a generated slug on first read.
 *
 * Created on read rather than with the feedback database, so a slug is only claimed
 * for a form someone has actually looked at. FR-131 keeps it disabled until asked for.
 */
export async function getHostedForm(
  ctx: AppContext,
  databaseId: string,
): Promise<HostedFormRow> {
  const existing = await ctx.db
    .select()
    .from(hostedForms)
    .where(eq(hostedForms.feedbackDatabaseId, databaseId))
    .limit(1);
  if (existing[0]) return existing[0];

  // A generated slug can in principle collide, so retry a few times rather than
  // failing a first page load on a coincidence.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const inserted = await ctx.db
      .insert(hostedForms)
      .values({ feedbackDatabaseId: databaseId, slug: generateSlug() })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) return inserted[0];

    const raced = await ctx.db
      .select()
      .from(hostedForms)
      .where(eq(hostedForms.feedbackDatabaseId, databaseId))
      .limit(1);
    if (raced[0]) return raced[0];
  }
  throw apiError('internal_error', 'A hosted form address could not be reserved.');
}

export type HostedFormPatch = {
  enabled?: boolean;
  slug?: string;
  accentColor?: string;
  colorScheme?: ColorScheme;
  cornerRadius?: CornerRadius;
  typeface?: Typeface;
  logoAlt?: string | null;
  submitLabel?: string;
  thankYouTitle?: string;
  thankYouBody?: string;
  closedMessage?: string;
  redirectUrl?: string | null;
  showProgress?: boolean;
  embedding?: EmbeddingMode;
  allowedOrigins?: string[];
};

export async function updateHostedForm(
  ctx: AppContext,
  databaseId: string,
  patch: HostedFormPatch,
): Promise<HostedFormRow> {
  await getHostedForm(ctx, databaseId);

  if (patch.slug !== undefined) await assertSlugAvailable(ctx, databaseId, patch.slug);

  // FR-135: a listed-origins mode with no origins would silently block every frame,
  // which is not what someone choosing "listed" means.
  const embedding = patch.embedding;
  if (embedding === 'listed') {
    const origins = patch.allowedOrigins ?? (await getHostedForm(ctx, databaseId)).allowedOrigins;
    if (origins.length === 0) {
      throw apiError(
        'validation_failed',
        'Add at least one origin, or choose to allow embedding anywhere or nowhere.',
        [{ path: 'allowedOrigins', code: 'required', message: 'At least one origin is needed.' }],
      );
    }
  }

  const updated = await ctx.db
    .update(hostedForms)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(hostedForms.feedbackDatabaseId, databaseId))
    .returning();
  const row = updated[0];
  if (!row) throw errors.databaseNotFound();
  return row;
}

/** FR-133: the previous address stops working the moment this returns. */
export async function rotateSlug(
  ctx: AppContext,
  databaseId: string,
): Promise<HostedFormRow> {
  await getHostedForm(ctx, databaseId);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = generateSlug();
    const clash = await ctx.db
      .select({ slug: hostedForms.slug })
      .from(hostedForms)
      .where(eq(hostedForms.slug, slug))
      .limit(1);
    if (clash[0]) continue;

    const updated = await ctx.db
      .update(hostedForms)
      .set({ slug, updatedAt: new Date() })
      .where(eq(hostedForms.feedbackDatabaseId, databaseId))
      .returning();
    if (updated[0]) return updated[0];
  }
  throw apiError('internal_error', 'A new hosted form address could not be reserved.');
}

async function assertSlugAvailable(
  ctx: AppContext,
  databaseId: string,
  slug: string,
): Promise<void> {
  if (isReservedSlug(slug)) {
    throw apiError('name_conflict', `"${slug}" is reserved. Choose another address.`, [
      { path: 'slug', code: 'reserved', message: 'That address is reserved.' },
    ]);
  }

  const taken = await ctx.db
    .select({ id: hostedForms.feedbackDatabaseId })
    .from(hostedForms)
    .where(and(eq(hostedForms.slug, slug), ne(hostedForms.feedbackDatabaseId, databaseId)))
    .limit(1);
  if (taken[0]) {
    throw apiError('name_conflict', `"${slug}" is already in use. Choose another address.`, [
      { path: 'slug', code: 'taken', message: 'That address is taken.' },
    ]);
  }
}

// --- Logo (FR-140) ----------------------------------------------------------

/**
 * FR-140: a logo is validated by content and re-encoded exactly as a screenshot is,
 * through the same pipeline, so the same animation, format and pixel checks apply and
 * the stored bytes come from our own encoder.
 *
 * It is stored untagged rather than pending, because the pending tag is what the
 * lifecycle rule expires and a logo has no intent to expire with.
 */
export async function uploadLogo(
  ctx: AppContext,
  databaseId: string,
  source: Buffer,
  alt: string | null,
): Promise<HostedFormRow> {
  const hosted = await getHostedForm(ctx, databaseId);

  const image = await processImage(source, {
    maxSourceBytes: BRANDING_LIMITS.logoMaxSourceBytes,
    maxPixels: BRANDING_LIMITS.logoMaxPixels,
  });

  const previousKey = hosted.logoStorageKey;
  const storageKey = `logos/${databaseId}-${Date.now()}.webp`;
  await ctx.storage.putBound(storageKey, image.data, image.storedMediaType);

  const updated = await ctx.db
    .update(hostedForms)
    .set({
      logoStorageKey: storageKey,
      logoMediaType: image.storedMediaType,
      logoWidth: image.width,
      logoHeight: image.height,
      logoBytes: image.storedBytes,
      logoAlt: alt,
      updatedAt: new Date(),
    })
    .where(eq(hostedForms.feedbackDatabaseId, databaseId))
    .returning();
  const row = updated[0];
  if (!row) throw errors.databaseNotFound();

  // The key carries a timestamp so a replacement never collides with a cached one.
  // The old object is removed after the row points at the new one, so a failure here
  // leaves an orphan rather than a broken logo.
  if (previousKey) {
    await ctx.storage.delete(previousKey).catch((error: unknown) => {
      ctx.log.warn({ err: error, key: previousKey }, 'previous logo not deleted');
    });
  }
  return row;
}

export async function removeLogo(ctx: AppContext, databaseId: string): Promise<HostedFormRow> {
  const hosted = await getHostedForm(ctx, databaseId);
  if (!hosted.logoStorageKey) return hosted;

  const updated = await ctx.db
    .update(hostedForms)
    .set({
      logoStorageKey: null,
      logoMediaType: null,
      logoWidth: null,
      logoHeight: null,
      logoBytes: null,
      logoAlt: null,
      updatedAt: new Date(),
    })
    .where(eq(hostedForms.feedbackDatabaseId, databaseId))
    .returning();

  await ctx.storage.delete(hosted.logoStorageKey).catch((error: unknown) => {
    ctx.log.warn({ err: error, key: hosted.logoStorageKey }, 'logo object not deleted');
  });

  const row = updated[0];
  if (!row) throw errors.databaseNotFound();
  return row;
}

/** FR-154: the logo goes with the feedback database or the project. */
export async function logoKeysForDatabase(
  ctx: AppContext,
  databaseId: string,
): Promise<string[]> {
  const rows = await ctx.db
    .select({ key: hostedForms.logoStorageKey })
    .from(hostedForms)
    .where(eq(hostedForms.feedbackDatabaseId, databaseId));
  return rows.flatMap((row) => (row.key ? [row.key] : []));
}

export async function logoKeysForProject(
  ctx: AppContext,
  projectId: string,
): Promise<string[]> {
  const rows = await ctx.db
    .select({ key: hostedForms.logoStorageKey })
    .from(hostedForms)
    .innerJoin(
      feedbackDatabases,
      eq(feedbackDatabases.id, hostedForms.feedbackDatabaseId),
    )
    .where(eq(feedbackDatabases.projectId, projectId));
  return rows.flatMap((row) => (row.key ? [row.key] : []));
}

// --- The public side --------------------------------------------------------

export type ResolvedHostedForm = {
  hosted: HostedFormRow;
  database: FeedbackDatabaseRow;
};

/**
 * FR-134: a hosted form request is authorized by its slug alone.
 *
 * An unknown slug and a disabled hosted form are deliberately different: an unknown
 * slug is a 404 because there is nothing there, while a disabled one is a real page
 * that is closed, and the respondent deserves the operator's own message rather than
 * a dead end. Whether the form is *published* is resolved separately, because that
 * changes without the operator touching the hosted form at all.
 */
export async function resolveSlug(ctx: AppContext, slug: string): Promise<ResolvedHostedForm> {
  const rows = await ctx.db
    .select({ hosted: hostedForms, database: feedbackDatabases })
    .from(hostedForms)
    .innerJoin(feedbackDatabases, eq(feedbackDatabases.id, hostedForms.feedbackDatabaseId))
    .where(eq(hostedForms.slug, slug.toLowerCase()))
    .limit(1);

  const found = rows[0];
  if (!found) throw apiError('not_found', 'There is no form at this address.');
  return found;
}

export type HostedFormPublicView = {
  slug: string;
  /** True when the form is enabled and has an active published version. */
  open: boolean;
  /** Present only when open, so a closed page cannot leak the questions. */
  form: {
    feedbackDatabaseId: string;
    formVersion: number;
    pages: ClientFormDefinition['pages'];
  } | null;
  /** Shown instead of the form when it is closed (FR-142). */
  closedMessage: string;
  branding: {
    logoUrl: string | null;
    logoAlt: string | null;
    logoWidth: number | null;
    logoHeight: number | null;
    accentColor: string;
    colorScheme: ColorScheme;
    cornerRadius: CornerRadius;
    typeface: Typeface;
  };
  copy: { submitLabel: string; thankYouTitle: string; thankYouBody: string };
  behaviour: { redirectUrl: string | null; showProgress: boolean };
};

/**
 * What the public page receives.
 *
 * A closed form returns no questions at all. That matters: disabling a hosted form
 * should stop it handing out the form's contents, not merely stop it accepting
 * answers.
 */
export async function hostedFormPublicView(
  ctx: AppContext,
  resolved: ResolvedHostedForm,
): Promise<HostedFormPublicView> {
  const { hosted, database } = resolved;

  const version = hosted.enabled && database.activeVersionId
    ? await getVersionById(ctx.db, database.activeVersionId)
    : null;

  return {
    slug: hosted.slug,
    open: version !== null,
    form: version
      ? {
          feedbackDatabaseId: database.id,
          formVersion: version.version,
          pages: toClientDefinition(version.definition).pages,
        }
      : null,
    closedMessage: hosted.closedMessage,
    branding: {
      logoUrl: hosted.logoStorageKey ? `/v1/hosted/${hosted.slug}/logo` : null,
      logoAlt: hosted.logoAlt,
      logoWidth: hosted.logoWidth,
      logoHeight: hosted.logoHeight,
      accentColor: hosted.accentColor,
      colorScheme: hosted.colorScheme,
      cornerRadius: hosted.cornerRadius,
      typeface: hosted.typeface,
    },
    copy: {
      submitLabel: hosted.submitLabel,
      thankYouTitle: hosted.thankYouTitle,
      thankYouBody: hosted.thankYouBody,
    },
    behaviour: { redirectUrl: hosted.redirectUrl, showProgress: hosted.showProgress },
  };
}

/**
 * FR-135: the headers a browser honours for framing.
 *
 * `frame-ancestors` is the one that matters, because it takes a list and is respected
 * by every current browser. `X-Frame-Options` is sent alongside only for the
 * all-or-nothing cases, where it can express the same thing, for the benefit of
 * anything old enough not to read CSP.
 */
export function frameHeaders(hosted: HostedFormRow): Record<string, string> {
  // Inlet's own origin is always allowed, in every mode. The management interface
  // previews the real page in a frame (FR-152), and an operator choosing "nowhere"
  // means nowhere else, not nowhere including their own settings page.
  if (hosted.embedding === 'nowhere') {
    return {
      'content-security-policy': "frame-ancestors 'self'",
      'x-frame-options': 'SAMEORIGIN',
    };
  }
  if (hosted.embedding === 'listed') {
    const origins = ["'self'", ...hosted.allowedOrigins].join(' ');
    return { 'content-security-policy': `frame-ancestors ${origins}` };
  }
  return { 'content-security-policy': 'frame-ancestors *' };
}

/** The absolute address an operator shares (FR-152). */
export function hostedFormUrl(ctx: AppContext, slug: string): string {
  return `${ctx.env.INLET_PUBLIC_URL.replace(/\/$/, '')}/f/${slug}`;
}

/**
 * The CSS the hosted page's initial HTML carries.
 *
 * Injected server-side so the operator's brand is present on the first paint. Without
 * it the page would flash Inlet's neutral defaults before the configuration arrives,
 * which on someone else's branded form reads as a bug.
 *
 * All three colour schemes are emitted, because the server cannot know what the
 * viewer's device prefers: an explicit choice writes one block, and "system" writes a
 * light block plus a dark one behind a media query. Every value comes from a validated
 * hex colour or a closed enum, so none of it needs escaping.
 */
export function hostedFormStyle(hosted: HostedFormRow): string {
  const branding = {
    accentColor: hosted.accentColor,
    colorScheme: hosted.colorScheme,
    cornerRadius: hosted.cornerRadius,
    typeface: hosted.typeface,
    logoAlt: hosted.logoAlt,
  };

  const block = (dark: boolean): string =>
    Object.entries(brandingVariables(branding, dark))
      .map(([name, value]) => `${name}:${value}`)
      .join(';');

  if (hosted.colorScheme === 'light') return `:root{${block(false)}}`;
  if (hosted.colorScheme === 'dark') return `:root{${block(true)}}`;
  return [
    `:root{${block(false)}}`,
    `@media (prefers-color-scheme:dark){:root{${block(true)}}}`,
  ].join('');
}
