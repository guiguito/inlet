import { z } from 'zod';

/**
 * Hosted form branding (FR-138 to FR-143).
 *
 * Shared between the API and the web app because the same values are validated when
 * saved, rendered in the builder's preview, and rendered on the public page. One
 * definition means the preview cannot show something the page will not.
 *
 * Every setting is presentation only (section 22.5): branding cannot change what is
 * asked, what is validated, or what is stored.
 */

/** A six-digit hex colour. Three-digit shorthand is expanded on the way in. */
export const hexColorSchema = z
  .string()
  .trim()
  .transform((value) => {
    const bare = value.replace(/^#/, '');
    const expanded =
      bare.length === 3
        ? bare
            .split('')
            .map((char) => char + char)
            .join('')
        : bare;
    return `#${expanded.toUpperCase()}`;
  })
  .refine((value) => /^#[0-9A-F]{6}$/.test(value), 'expected a hex colour like #C2410C');

export const COLOR_SCHEMES = ['light', 'dark', 'system'] as const;
export const CORNER_RADII = ['sharp', 'soft', 'round'] as const;
export const TYPEFACES = ['sans', 'serif', 'mono'] as const;
export const EMBEDDING_MODES = ['anywhere', 'listed', 'nowhere'] as const;

export type ColorScheme = (typeof COLOR_SCHEMES)[number];
export type CornerRadius = (typeof CORNER_RADII)[number];
export type Typeface = (typeof TYPEFACES)[number];
export type EmbeddingMode = (typeof EMBEDDING_MODES)[number];

export const BRANDING_LIMITS = {
  submitLabelMaxLength: 60,
  thankYouTitleMaxLength: 120,
  thankYouBodyMaxLength: 600,
  closedMessageMaxLength: 600,
  logoAltMaxLength: 200,
  allowedOriginsMax: 20,
  /** A logo is a small mark, not a screenshot, so it gets a tighter ceiling. */
  logoMaxSourceBytes: 1024 * 1024,
  logoMaxPixels: 4_000_000,
  slugMinLength: 3,
  slugMaxLength: 64,
} as const;

/**
 * FR-132: a slug is lowercase, alphanumeric and hyphenated, and cannot begin or end
 * with a hyphen. Narrow on purpose: it appears in a URL people paste into emails and
 * read aloud, so it excludes anything that needs escaping or explaining.
 */
export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(BRANDING_LIMITS.slugMinLength)
  .max(BRANDING_LIMITS.slugMaxLength)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'use lowercase letters, digits and single hyphens, starting and ending with a letter or digit',
  );

/**
 * Slugs the product needs for itself, so a custom slug cannot shadow a route or read
 * as something official.
 */
export const RESERVED_SLUGS = new Set([
  'admin',
  'api',
  'app',
  'assets',
  'auth',
  'dashboard',
  'docs',
  'f',
  'favicon',
  'health',
  'help',
  'inlet',
  'invitations',
  'login',
  'logo',
  'logout',
  'new',
  'openapi',
  'preview',
  'projects',
  'render',
  'settings',
  'sign-in',
  'sign-out',
  'static',
  'support',
  'v1',
]);

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.toLowerCase());
}

/** An origin, for the listed-embedding mode. Scheme and host only, never a path. */
export const originSchema = z
  .string()
  .trim()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        url.pathname === '/' &&
        url.search === '' &&
        url.hash === ''
      );
    } catch {
      return false;
    }
  }, 'expected an origin like https://example.com, with no path')
  .transform((value) => new URL(value).origin);

export const brandingSchema = z.object({
  accentColor: hexColorSchema,
  colorScheme: z.enum(COLOR_SCHEMES),
  cornerRadius: z.enum(CORNER_RADII),
  typeface: z.enum(TYPEFACES),
  logoAlt: z.string().trim().max(BRANDING_LIMITS.logoAltMaxLength).nullable(),
});

export type Branding = z.infer<typeof brandingSchema>;

// --- Contrast ---------------------------------------------------------------

/**
 * FR-139: the readable foreground for a colour, derived rather than configured.
 *
 * Choosing whichever of white or black contrasts better is not just a heuristic: the
 * two contrast ratios cross at a relative luminance of 0.1791, where both equal
 * 4.58:1. So picking the better one always clears WCAG AA's 4.5:1 for normal text,
 * whatever accent an operator chooses. That is the whole reason this is computed and
 * not left as a setting someone can get wrong.
 */
export function readableForeground(hex: string): '#FFFFFF' | '#000000' {
  return relativeLuminance(hex) < 0.1791 ? '#FFFFFF' : '#000000';
}

/** WCAG relative luminance. */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two colours, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  const bare = hex.replace(/^#/, '');
  const full =
    bare.length === 3
      ? bare
          .split('')
          .map((char) => char + char)
          .join('')
      : bare;
  return {
    r: Number.parseInt(full.slice(0, 2), 16) || 0,
    g: Number.parseInt(full.slice(2, 4), 16) || 0,
    b: Number.parseInt(full.slice(4, 6), 16) || 0,
  };
}

// --- Rendering --------------------------------------------------------------

/** The CSS custom properties the renderer reads, derived from branding. */
export type BrandingVariables = Record<string, string>;

const RADIUS_CSS: Record<CornerRadius, string> = {
  sharp: '0px',
  soft: '0.5rem',
  round: '1rem',
};

const TYPEFACE_CSS: Record<Typeface, string> = {
  sans: "'Geist Variable', ui-sans-serif, system-ui, -apple-system, sans-serif",
  serif: "ui-serif, Georgia, Cambria, 'Times New Roman', serif",
  mono: "'Geist Mono Variable', ui-monospace, 'SF Mono', Menlo, monospace",
};

/**
 * Turns branding into the variables the form renderer already themes from.
 *
 * Only the accent and its foreground come from branding; the neutral palette comes
 * from the colour scheme. That keeps a branded form legible without asking an
 * operator to pick six colours that work together.
 */
export function brandingVariables(branding: Branding, dark: boolean): BrandingVariables {
  const neutrals = dark
    ? {
        '--r-bg': '#09090B',
        '--r-surface': '#18181B',
        '--r-text': '#FAFAFA',
        '--r-muted': '#A1A1AA',
        '--r-border': '#27272A',
        '--r-hover': '#232326',
        '--r-selected-bg': '#27272A',
        '--r-danger': '#F87171',
      }
    : {
        '--r-bg': '#FFFFFF',
        '--r-surface': '#FFFFFF',
        '--r-text': '#18181B',
        '--r-muted': '#71717A',
        '--r-border': '#E4E4E7',
        '--r-hover': '#FAFAFA',
        '--r-selected-bg': '#F4F4F5',
        '--r-danger': '#B91C1C',
      };

  return {
    ...neutrals,
    '--r-radius': RADIUS_CSS[branding.cornerRadius],
    '--r-font': TYPEFACE_CSS[branding.typeface],
    '--r-accent': branding.accentColor,
    '--r-accent-contrast': readableForeground(branding.accentColor),
    // The selected border uses the accent, so a chosen option reads as chosen without
    // needing a second configured colour.
    '--r-selected-border': branding.accentColor,
  };
}

/** Whether to render dark, given the scheme and what the viewer's device prefers. */
export function resolveDark(scheme: ColorScheme, prefersDark: boolean): boolean {
  if (scheme === 'light') return false;
  if (scheme === 'dark') return true;
  return prefersDark;
}
