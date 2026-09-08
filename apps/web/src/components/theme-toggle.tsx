import { useEffect, useState } from 'react';
import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Theme = 'light' | 'dark' | 'system';
const STORAGE_KEY = 'inlet-theme';

function resolve(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function apply(theme: Theme): void {
  document.documentElement.classList.toggle('dark', resolve(theme) === 'dark');
}

export function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // Site data can be blocked; the default is fine.
  }
  return 'system';
}

/** Applied before React renders so the first paint is already in the right theme. */
export function initTheme(): void {
  apply(readStoredTheme());
}

const NEXT: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
const ICON = { system: MonitorIcon, light: SunIcon, dark: MoonIcon };

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);

  useEffect(() => {
    apply(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Not being able to remember the choice is not worth an error.
    }
    if (theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = () => apply('system');
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, [theme]);

  const Icon = ICON[theme];

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={() => setTheme(NEXT[theme])}
      aria-label={`Theme: ${theme}. Switch to ${NEXT[theme]}`}
      title={`Theme: ${theme}`}
    >
      <Icon />
    </Button>
  );
}
