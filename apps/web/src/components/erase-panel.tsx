import { useEffect, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { EraserIcon, SearchIcon } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { erasureApi, type ErasureKind, type ErasurePreview, type ErasureResult } from '@/lib/erasure';
import { pluralize } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/**
 * The project's erasure of an installation or user ID (Foundations FD-033, UX Analytics AN-183 to
 * AN-185, 5.8, 8.1): the ID, the preview with what each database would lose and a checkbox to
 * select it, the sentence saying it matches identity fields only, the ID typed to confirm, what
 * erasure does not reach, and what was deleted in each database. An analytics profile's Erase
 * opens it in a dialog (`framed={false}`) with the ID filled in, the profile's database selected
 * and the preview read at once (`initial`), so a database Admin who is no member of the project,
 * and cannot open its settings, erases from the profile too (5.8, 8.1 "Users").
 */

const UNITS: Record<string, [string, string?]> = {
  reports: ['crash report'],
  groupUsers: ['group-user association'],
  submissions: ['submission'],
  attachments: ['screenshot'],
  events: ['event'],
  installations: ['installation'],
};
const TYPE_LABELS = { crash: 'Crash', feedback: 'Feedback', analytics: 'Analytics' } as const;

export const ERASE_PURPOSE =
  'To honour a person’s request to delete their data: deletes the crash reports, feedback submissions and analytics events carrying their ID in the databases you select and administer.';

function countsText(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([key, value]) => pluralize(value, ...(UNITS[key] ?? [key])))
    .join(', ');
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export function ErasePanel({
  projectId,
  initial,
  framed = true,
}: {
  projectId: string;
  initial?: { kind: ErasureKind; id: string; databaseId?: string } | undefined;
  /** False inside a dialog, which carries its own title. */
  framed?: boolean;
}) {
  const [kind, setKind] = useState<ErasureKind>(initial?.kind ?? 'user');
  const [id, setId] = useState(initial?.id ?? '');
  const [preview, setPreview] = useState<ErasurePreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [typed, setTyped] = useState('');
  const [result, setResult] = useState<ErasureResult | null>(null);

  const look = useMutation({
    mutationFn: () => erasureApi.preview(projectId, kind, id.trim()),
    onSuccess: (answer) => {
      setPreview(answer);
      setResult(null);
      setTyped('');
      // From a profile, its database starts selected; otherwise the Admin selects each one.
      setSelected(new Set(answer.databases.filter((database) => database.id === initial?.databaseId).map((database) => database.id)));
    },
  });
  const erase = useMutation({
    mutationFn: () => erasureApi.erase(projectId, { kind: preview!.kind, id: preview!.id, confirm: typed, databases: [...selected] }),
    onSuccess: (answer) => {
      setResult(answer);
      setPreview(null);
      setTyped('');
    },
  });

  // AN-183, 8.1: from a profile, Erase opens the preview itself.
  useEffect(() => {
    if (initial) look.mutate();
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (id.trim() !== '') look.mutate();
  };
  const toggle = (databaseId: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(databaseId);
    else next.delete(databaseId);
    setSelected(next);
  };

  const body = (
    <>
        <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
          <div className="space-y-1.5">
            <Label htmlFor="erase-kind">Kind</Label>
            <Select value={kind} onValueChange={(next) => setKind(next as ErasureKind)}>
              <SelectTrigger id="erase-kind" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">User ID</SelectItem>
                <SelectItem value="installation">Installation ID</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-64 flex-1 space-y-1.5">
            <Label htmlFor="erase-id">ID</Label>
            <Input id="erase-id" value={id} maxLength={128} autoComplete="off" className="font-mono" onChange={(event) => setId(event.target.value)} />
          </div>
          <Button type="submit" variant="outline" disabled={look.isPending || id.trim() === ''}>
            <SearchIcon /> Preview
          </Button>
        </form>
        {look.error ? (
          <p role="alert" className="rounded-md border border-destructive/40 px-3 py-2 text-sm">
            {errorText(look.error, 'The preview could not be read.')}
          </p>
        ) : null}

        {preview ? (
          <div className="space-y-4" data-testid="erase-preview">
            <p className="text-sm">{preview.notice}</p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <span className="sr-only">Erase here</span>
                  </TableHead>
                  <TableHead>Database</TableHead>
                  <TableHead>What the erasure deletes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.databases.map((database) => (
                  <TableRow key={database.id}>
                    <TableCell>
                      <Checkbox
                        id={`erase-${database.id}`}
                        aria-label={`Erase in ${database.name}`}
                        checked={selected.has(database.id)}
                        onCheckedChange={(value) => toggle(database.id, value === true)}
                      />
                    </TableCell>
                    <TableCell>
                      <Label htmlFor={`erase-${database.id}`} className="font-normal">
                        {database.name} <Badge variant="outline">{TYPE_LABELS[database.type]}</Badge>
                      </Label>
                    </TableCell>
                    <TableCell className="numeric text-sm">
                      {database.counts
                        ? countsText(database.counts)
                        : 'The analytics event store is unreachable, so nothing could be counted; selected, the erasure is recorded and applies once it answers.'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {preview.databases.length === 0 ? <p className="text-sm text-muted-foreground">You administer no database of this project.</p> : null}
            <p className="text-sm text-muted-foreground">{preview.limits}</p>
            <div className="space-y-1.5">
              <Label htmlFor="erase-confirm">
                Type <span className="break-all font-mono text-foreground">{preview.id}</span> to confirm
              </Label>
              <Input id="erase-confirm" value={typed} autoComplete="off" className="font-mono" onChange={(event) => setTyped(event.target.value)} />
            </div>
            {erase.error ? (
              <p role="alert" className="rounded-md border border-destructive/40 px-3 py-2 text-sm">
                {errorText(erase.error, 'The erasure did not complete.')}
              </p>
            ) : null}
            <Button variant="destructive" disabled={erase.isPending || selected.size === 0 || typed !== preview.id} onClick={() => erase.mutate()}>
              <EraserIcon /> {erase.isPending ? 'Erasing' : `Erase in ${pluralize(selected.size, 'database')}`}
            </Button>
          </div>
        ) : null}

        {result ? (
          <div className="space-y-3" data-testid="erase-result" role="status">
            <p className="text-sm font-medium">Erased. What each database lost:</p>
            <ul className="space-y-1 text-sm">
              {result.databases.map((database) => (
                <li key={database.id}>
                  <span className="font-medium">{database.name}</span>:{' '}
                  {database.deleted
                    ? countsText(database.deleted)
                    : 'recorded; the event store was unreachable, so it applies once it answers.'}
                </li>
              ))}
            </ul>
            <p className="text-sm text-muted-foreground">
              Analytics events are unreadable from now on and leave the event store’s files within the deployment’s bound. {result.limits}
            </p>
          </div>
        ) : null}
    </>
  );

  if (!framed) {
    return (
      <div className="space-y-4" data-testid="erase-panel">
        {body}
      </div>
    );
  }
  return (
    <Card data-testid="erase-panel" id="erase">
      <CardHeader>
        <CardTitle>Erase an installation or user ID</CardTitle>
        <CardDescription>{ERASE_PURPOSE}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">{body}</CardContent>
    </Card>
  );
}
