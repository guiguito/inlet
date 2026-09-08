import { useState } from 'react';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** A monospace value with a copy button. IDs and keys are set in Geist Mono. */
export function CopyField({
  value,
  label,
  className,
  masked = false,
}: {
  value: string;
  label?: string;
  className?: string;
  masked?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be refused; the value stays selectable either way.
    }
  };

  return (
    <div className={cn('space-y-1.5', className)}>
      {label ? <p className="text-xs font-medium text-muted-foreground">{label}</p> : null}
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border bg-muted/40 px-2.5 py-1.5 font-mono text-xs">
          {masked ? `${value.slice(0, 12)}${'•'.repeat(12)}` : value}
        </code>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          onClick={copy}
          aria-label={copied ? 'Copied' : `Copy ${label ?? 'value'}`}
        >
          {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
        </Button>
      </div>
    </div>
  );
}
