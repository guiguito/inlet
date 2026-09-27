import { useId } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { parseJson } from './format';

/**
 * The JSON editor of PRD 8.1: a monospace text area that parses on every input and shows the
 * parse error with its line and column, and a Format button. No editor dependency: the text is
 * the state, so an invalid value is kept while it is typed. `optional` allows an empty text
 * (a schema that is not set).
 */
export function JsonEditor({
  label,
  value,
  onChange,
  optional = false,
  problems = [],
  rows = 6,
}: {
  label: string;
  value: string;
  onChange: (text: string) => void;
  optional?: boolean;
  problems?: string[];
  rows?: number;
}) {
  const id = useId();
  const empty = value.trim() === '';
  const parsed = empty ? null : parseJson(value);
  const error = empty ? (optional ? null : 'Enter a JSON value.') : parsed && !parsed.ok ? parsed.error : null;
  const messages = [...(error ? [error] : []), ...problems];

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!parsed?.ok}
          aria-label={`Format ${label.toLowerCase()}`}
          onClick={() => parsed?.ok && onChange(JSON.stringify(parsed.value, null, 2))}
        >
          Format
        </Button>
      </div>
      <Textarea
        id={id}
        value={value}
        rows={rows}
        spellCheck={false}
        className={cn('font-mono text-xs', messages.length > 0 && 'border-destructive')}
        aria-invalid={messages.length > 0}
        aria-describedby={messages.length > 0 ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {messages.length > 0 ? (
        <ul id={`${id}-error`} className="space-y-0.5 text-xs text-destructive">
          {messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
