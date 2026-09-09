import { describe, expect, it } from 'vitest';
import {
  brandingVariables,
  contrastRatio,
  hexColorSchema,
  isReservedSlug,
  originSchema,
  readableForeground,
  relativeLuminance,
  resolveDark,
  slugSchema,
} from '@inlet/shared';

/** Hosted form branding (FR-132, FR-138, FR-139). */
describe('hexColorSchema', () => {
  it('accepts a six-digit hex, with or without the hash', () => {
    expect(hexColorSchema.parse('#c2410c')).toBe('#C2410C');
    expect(hexColorSchema.parse('c2410c')).toBe('#C2410C');
    expect(hexColorSchema.parse('  #C2410C  ')).toBe('#C2410C');
  });

  it('expands three-digit shorthand', () => {
    expect(hexColorSchema.parse('#f0a')).toBe('#FF00AA');
  });

  it('rejects anything else', () => {
    for (const bad of ['', '#12345', 'rebeccapurple', 'rgb(1,2,3)', '#12345g']) {
      expect(hexColorSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('readableForeground', () => {
  it('picks white on dark accents and black on light ones', () => {
    expect(readableForeground('#18181B')).toBe('#FFFFFF');
    expect(readableForeground('#C2410C')).toBe('#FFFFFF');
    expect(readableForeground('#2563EB')).toBe('#FFFFFF');
    expect(readableForeground('#FB923C')).toBe('#000000');
    expect(readableForeground('#FACC15')).toBe('#000000');
    expect(readableForeground('#FFFFFF')).toBe('#000000');
  });

  /**
   * FR-139's guarantee. The two contrast ratios cross at a relative luminance of
   * 0.1791 where both equal 4.58:1, so picking the better one always clears AA. This
   * sweeps the whole colour space rather than trusting the arithmetic.
   */
  it('never falls below WCAG AA for normal text, whatever the accent', () => {
    let worst = Number.POSITIVE_INFINITY;
    let worstColor = '';

    for (let r = 0; r < 256; r += 5) {
      for (let g = 0; g < 256; g += 5) {
        for (let b = 0; b < 256; b += 5) {
          const hex = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
          const ratio = contrastRatio(hex, readableForeground(hex));
          if (ratio < worst) {
            worst = ratio;
            worstColor = hex;
          }
        }
      }
    }

    expect(worst, `worst accent was ${worstColor}`).toBeGreaterThanOrEqual(4.5);
  });

  it('always chooses the better of the two, not merely an adequate one', () => {
    for (const hex of ['#808080', '#7F7F7F', '#16A34A', '#0EA5E9', '#DB2777']) {
      const chosen = contrastRatio(hex, readableForeground(hex));
      const other = contrastRatio(hex, readableForeground(hex) === '#FFFFFF' ? '#000000' : '#FFFFFF');
      expect(chosen, hex).toBeGreaterThanOrEqual(other);
    }
  });
});

describe('relativeLuminance and contrastRatio', () => {
  it('matches the WCAG reference values at the extremes', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 5);
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 2);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#C2410C', '#FFFFFF')).toBeCloseTo(
      contrastRatio('#FFFFFF', '#C2410C'),
      6,
    );
  });
});

describe('slugSchema', () => {
  it('accepts a shareable slug and lowercases it', () => {
    expect(slugSchema.parse('deblock-feedback')).toBe('deblock-feedback');
    expect(slugSchema.parse('  Deblock-Feedback  ')).toBe('deblock-feedback');
    expect(slugSchema.parse('app2')).toBe('app2');
  });

  it('rejects shapes that would need escaping or explaining', () => {
    for (const bad of [
      'ab',
      '-leading',
      'trailing-',
      'double--hyphen',
      'has space',
      'has_underscore',
      'has.dot',
      'has/slash',
      'Ünïcode',
      'a'.repeat(65),
    ]) {
      expect(slugSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('isReservedSlug', () => {
  it('protects the product’s own routes', () => {
    for (const reserved of ['v1', 'docs', 'sign-in', 'invitations', 'f', 'render']) {
      expect(isReservedSlug(reserved), reserved).toBe(true);
    }
    expect(isReservedSlug('DOCS')).toBe(true);
    expect(isReservedSlug('deblock-feedback')).toBe(false);
  });
});

describe('originSchema', () => {
  it('accepts an origin and normalizes it', () => {
    expect(originSchema.parse('https://example.com')).toBe('https://example.com');
    expect(originSchema.parse('https://example.com/')).toBe('https://example.com');
    expect(originSchema.parse('http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('rejects anything carrying a path, query or fragment', () => {
    for (const bad of [
      'https://example.com/embed',
      'https://example.com?a=1',
      'https://example.com#x',
      'example.com',
      'ftp://example.com',
      '*',
    ]) {
      expect(originSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('brandingVariables', () => {
  const branding = {
    accentColor: '#C2410C',
    colorScheme: 'system' as const,
    cornerRadius: 'soft' as const,
    typeface: 'sans' as const,
    logoAlt: null,
  };

  it('derives the accent foreground rather than taking one', () => {
    expect(brandingVariables(branding, false)['--r-accent-contrast']).toBe('#FFFFFF');
    expect(
      brandingVariables({ ...branding, accentColor: '#FACC15' }, false)['--r-accent-contrast'],
    ).toBe('#000000');
  });

  it('swaps the neutral palette for dark, keeping the accent', () => {
    const light = brandingVariables(branding, false);
    const dark = brandingVariables(branding, true);

    expect(light['--r-bg']).not.toBe(dark['--r-bg']);
    expect(light['--r-text']).not.toBe(dark['--r-text']);
    expect(dark['--r-accent']).toBe('#C2410C');
  });

  it('keeps the neutral text legible on the neutral background in both schemes', () => {
    for (const dark of [false, true]) {
      const vars = brandingVariables(branding, dark);
      expect(contrastRatio(vars['--r-text'] ?? '', vars['--r-bg'] ?? '')).toBeGreaterThan(7);
      expect(contrastRatio(vars['--r-muted'] ?? '', vars['--r-bg'] ?? '')).toBeGreaterThan(4.5);
    }
  });

  it('maps each radius and typeface choice to something concrete', () => {
    expect(brandingVariables({ ...branding, cornerRadius: 'sharp' }, false)['--r-radius']).toBe('0px');
    expect(brandingVariables({ ...branding, cornerRadius: 'round' }, false)['--r-radius']).toBe('1rem');
    expect(brandingVariables({ ...branding, typeface: 'serif' }, false)['--r-font']).toContain('serif');
    expect(brandingVariables({ ...branding, typeface: 'mono' }, false)['--r-font']).toContain('mono');
  });
});

describe('resolveDark', () => {
  it('honours an explicit choice and follows the device otherwise', () => {
    expect(resolveDark('light', true)).toBe(false);
    expect(resolveDark('dark', false)).toBe(true);
    expect(resolveDark('system', true)).toBe(true);
    expect(resolveDark('system', false)).toBe(false);
  });
});
