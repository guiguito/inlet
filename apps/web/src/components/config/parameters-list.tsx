import { useDeferredValue, useMemo, useState } from 'react';
import { SearchIcon } from 'lucide-react';
import type { ConfigDraft } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { inlineValue, shortValue, TYPE_LABELS } from './format';

/**
 * The Parameters view (PRD 8.1): a search box and one row per parameter — the key in the
 * monospace face, a type badge, a live badge, the description, the default on one line and a
 * chip per conditional value in priority order — with the draft's problems beside it (RC-050).
 */
export function ParametersList({ draft, onOpen }: { draft: ConfigDraft; onOpen: (key: string) => void }) {
  const [search, setSearch] = useState('');
  // Typing stays responsive at 500 parameters: the list re-renders at the deferred value.
  const query = useDeferredValue(search.trim().toLowerCase());
  const { parameters, conditions } = draft.template;

  const conditionOrder = useMemo(() => new Map(conditions.map((condition, index) => [condition.id, { index, name: condition.name }])), [conditions]);
  const problems = useMemo(() => {
    const byKey = new Map<string, string[]>();
    for (const problem of draft.problems) if (problem.parameter) byKey.set(problem.parameter, [...(byKey.get(problem.parameter) ?? []), problem.message]);
    return byKey;
  }, [draft.problems]);
  const shown = query
    ? parameters.filter((parameter) => parameter.key.toLowerCase().includes(query) || (parameter.description ?? '').toLowerCase().includes(query))
    : parameters;

  return (
    <div className="space-y-3">
      <div className="relative max-w-sm">
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input className="pl-9" type="search" placeholder="Search parameters" aria-label="Search parameters" value={search} onChange={(event) => setSearch(event.target.value)} />
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">No parameter matches “{search}”.</p>
      ) : (
        <ul className="divide-y rounded-lg border" aria-label="Parameters">
          {shown.map((parameter) => {
            const chips = [...parameter.conditional]
              .filter((entry) => conditionOrder.has(entry.condition))
              .sort((a, b) => conditionOrder.get(a.condition)!.index - conditionOrder.get(b.condition)!.index);
            const own = problems.get(parameter.key) ?? [];
            return (
              <li key={parameter.key} data-testid={`parameter-${parameter.key}`}>
                <button
                  type="button"
                  className="block w-full space-y-1.5 px-4 py-3 text-left transition-colors hover:bg-accent/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                  onClick={() => onOpen(parameter.key)}
                  aria-label={`Open ${parameter.key}`}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-medium">{parameter.key}</span>
                    <Badge variant="outline">{TYPE_LABELS[parameter.type]}</Badge>
                    {parameter.live ? <Badge variant="primary">Live</Badge> : null}
                    {own.length > 0 ? <Badge variant="destructive">{own.length === 1 ? '1 problem' : `${own.length} problems`}</Badge> : null}
                  </span>
                  {parameter.description ? <span className="block text-[13px] text-muted-foreground">{parameter.description}</span> : null}
                  <span className="block truncate font-mono text-xs" title={inlineValue(parameter.default)}>
                    <span className="font-sans text-muted-foreground">Default: </span>
                    {inlineValue(parameter.default)}
                  </span>
                  {chips.length > 0 ? (
                    <span className="flex flex-wrap gap-1.5">
                      {chips.map((entry) => (
                        <Badge key={`${entry.condition}:${entry.variant ?? ''}`} variant="muted" className="max-w-72 truncate font-normal">
                          {conditionOrder.get(entry.condition)!.name}
                          {entry.variant ? `: ${entry.variant}` : ''} → {truncate(shortValue(entry.value))}
                        </Badge>
                      ))}
                    </span>
                  ) : null}
                  {own.length > 0 ? (
                    <span className="block space-y-0.5 text-xs text-destructive">
                      {own.map((message) => (
                        <span key={message} className="block">
                          {message}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function truncate(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}
