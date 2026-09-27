import { cn } from '@/lib/utils';

/** UX Analytics 11: the IP-to-country database's attribution, in Settings → General and beside country figures. */
export function CountryAttribution({ className }: { className?: string }) {
  return (
    <p className={cn('text-xs text-muted-foreground', className)} data-testid="country-attribution">
      IP to country data by{' '}
      <a className="underline" href="https://db-ip.com" target="_blank" rel="noreferrer">
        DB-IP (db-ip.com)
      </a>
      , CC BY 4.0
    </p>
  );
}
