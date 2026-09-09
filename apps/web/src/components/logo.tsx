import { cn } from '@/lib/utils';

/**
 * The Inlet mark (PRD section 20.4): the depth contours of a bay narrowing inland —
 * three nested lines that stop at the open mouth. Single stroke weight, monochrome,
 * no gradients.
 *
 * Below 20 pixels the innermost line closes up against the second, so the favicon in
 * `public/favicon.svg` carries two contours at a heavier weight. Keep the two in step.
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
      <path d="M3.5 4v10c0 6.9 5.6 12.5 12.5 12.5S28.5 20.9 28.5 14V4" />
      <path d="M11 4v11a5 5 0 0 0 10 0V4" />
      <path d="M16 4v9" />
    </svg>
  );
}

/** Mark plus lowercase wordmark, optically aligned to the outer contour. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 font-semibold tracking-tight', className)}>
      <Logo className="size-5 text-primary" />
      <span className="text-[15px] lowercase">inlet</span>
    </span>
  );
}
