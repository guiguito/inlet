import { cn } from '@/lib/utils';

/**
 * The Inlet mark (PRD section 20.4): a rounded rectangle standing for a page or form,
 * with a gap in its left edge and a short arrow entering through the gap. Single
 * stroke weight, monochrome, no gradients. Reads at 16 pixels.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('size-5', className)}
      aria-hidden="true"
    >
      <path d="M6 8.5A2.5 2.5 0 0 1 8.5 6h15A2.5 2.5 0 0 1 26 8.5v15A2.5 2.5 0 0 1 23.5 26h-15A2.5 2.5 0 0 1 6 23.5V20M6 12v-1.5" />
      <path d="M1.5 16H11" />
      <path d="M7.5 12.5 11 16l-3.5 3.5" />
    </svg>
  );
}

/** Mark plus lowercase wordmark, optically aligned to the rectangle. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 font-semibold tracking-tight', className)}>
      <Logo className="size-5 text-primary" />
      <span className="text-[15px] lowercase">inlet</span>
    </span>
  );
}
