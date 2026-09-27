import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { PlusIcon, XIcon } from 'lucide-react';
import { CONFIG_PLATFORMS, type ConfigContextBody, type ConfigTemplate } from '@inlet/shared';
import { api, ApiError, type ConfigDatabase, type ConfigDraft, type ConfigPreview, type ConfigSource } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { describeRule, inlineValue, PLATFORM_LABELS } from './format';

type Attribute = { key: string; type: 'string' | 'number' | 'boolean'; value: string };
const FIELDS = [
  { id: 'appVersion', label: 'App version', placeholder: '1.4.0' },
  { id: 'appBuild', label: 'App build', placeholder: '412' },
  { id: 'osVersion', label: 'OS version', placeholder: '17.2' },
  { id: 'locale', label: 'Locale', placeholder: 'fr-FR' },
  { id: 'country', label: 'Country', placeholder: 'FR' },
  { id: 'userId', label: 'User ID', placeholder: '' },
  { id: 'installationId', label: 'Installation ID', placeholder: 'a UUID' },
] as const;
type FieldId = (typeof FIELDS)[number]['id'];

function contextOf(platform: string, fields: Record<FieldId, string>, attributes: Attribute[]): ConfigContextBody {
  const value = (id: FieldId) => fields[id].trim() || undefined;
  const app = { version: value('appVersion'), build: value('appBuild') };
  const custom: NonNullable<ConfigContextBody['attributes']> = {};
  for (const attribute of attributes) {
    if (attribute.key.trim() === '') continue;
    custom[attribute.key.trim()] = attribute.type === 'number' ? Number(attribute.value) : attribute.type === 'boolean' ? attribute.value === 'true' : attribute.value;
  }
  // JSON drops the undefined fields, so an empty field is absent from the context.
  return {
    ...(platform && { platform }),
    ...((app.version || app.build) && { app }),
    ...(value('osVersion') && { os: { version: value('osVersion') } }),
    locale: value('locale'),
    country: value('country'),
    userId: value('userId'),
    installationId: value('installationId'),
    ...(Object.keys(custom).length > 0 && { attributes: custom }),
  };
}

/**
 * Preview as (RC-060): a context — platform, app version and build, OS version, locale, country,
 * user ID, installation ID and custom attributes — against the draft, the active version or a
 * numbered one; each parameter's value and where it came from, each condition's result with the
 * first rule that failed in plain words, the experiments, and for the draft what could not be
 * evaluated. A preview counts in no reach figure.
 */
export function PreviewPanel({ database, draft, onClose }: { database: ConfigDatabase; draft: ConfigDraft; onClose: () => void }) {
  const [platform, setPlatform] = useState('');
  const [fields, setFields] = useState<Record<FieldId, string>>({ appVersion: '', appBuild: '', osVersion: '', locale: '', country: '', userId: '', installationId: '' });
  const [attributes, setAttributes] = useState<Attribute[]>([]);
  const [source, setSource] = useState<'draft' | 'active' | 'version'>('draft');
  const [versionNumber, setVersionNumber] = useState('');

  const preview = useMutation({
    mutationFn: async (): Promise<{ answer: ConfigPreview; template: ConfigTemplate }> => {
      const chosen: ConfigSource = source === 'version' ? Number(versionNumber) : source;
      const answer = await api.previewConfig(database.id, contextOf(platform, fields, attributes), chosen);
      // The first false rule is an index into the previewed template's rules.
      const number = chosen === 'draft' ? null : chosen === 'active' ? (answer.version ?? database.activeVersion) : chosen;
      const template = number === null ? draft.template : (await api.getConfigVersion(database.id, number)).template;
      return { answer, template };
    },
  });
  const result = preview.data;
  const conditions = new Map((result?.template.conditions ?? []).map((condition) => [condition.id, condition]));

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Preview as</DialogTitle>
          <DialogDescription>Describe an app as it would fetch, and see what it would receive and why. A preview counts in no reach figure.</DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            preview.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="preview-source">Source</Label>
              <Select value={source} onValueChange={(next) => setSource(next as typeof source)}>
                <SelectTrigger id="preview-source">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">The draft</SelectItem>
                  <SelectItem value="active" disabled={database.activeVersion === null}>
                    The active version
                  </SelectItem>
                  <SelectItem value="version">
                    A version…
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            {source === 'version' ? (
              <div className="space-y-1.5">
                <Label htmlFor="preview-version">Version number</Label>
                <Input id="preview-version" type="number" min={1} value={versionNumber} onChange={(event) => setVersionNumber(event.target.value)} />
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="preview-platform">Platform</Label>
              <Select value={platform || 'none'} onValueChange={(next) => setPlatform(next === 'none' ? '' : next)}>
                <SelectTrigger id="preview-platform">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not set</SelectItem>
                  {CONFIG_PLATFORMS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {PLATFORM_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {FIELDS.map((field) => (
              <div key={field.id} className="space-y-1.5">
                <Label htmlFor={`preview-${field.id}`}>{field.label}</Label>
                <Input
                  id={`preview-${field.id}`}
                  className="font-mono"
                  placeholder={field.placeholder}
                  value={fields[field.id]}
                  autoComplete="off"
                  onChange={(event) => setFields({ ...fields, [field.id]: event.target.value })}
                />
              </div>
            ))}
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Custom attributes</p>
            {attributes.map((attribute, position) => (
              <div key={position} className="flex items-end gap-2">
                <div className="flex-1 space-y-1.5">
                  <Label htmlFor={`preview-attribute-key-${position}`}>Key</Label>
                  <Input id={`preview-attribute-key-${position}`} className="font-mono" value={attribute.key} onChange={(event) => setAttributes(attributes.map((other, place) => (place === position ? { ...other, key: event.target.value } : other)))} />
                </div>
                <div className="w-28 space-y-1.5">
                  <Label htmlFor={`preview-attribute-type-${position}`}>Type</Label>
                  <Select value={attribute.type} onValueChange={(type) => setAttributes(attributes.map((other, place) => (place === position ? { ...other, type: type as Attribute['type'] } : other)))}>
                    <SelectTrigger id={`preview-attribute-type-${position}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="string">Text</SelectItem>
                      <SelectItem value="number">Number</SelectItem>
                      <SelectItem value="boolean">Boolean</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex-1 space-y-1.5">
                  <Label htmlFor={`preview-attribute-value-${position}`}>Value</Label>
                  <Input
                    id={`preview-attribute-value-${position}`}
                    className="font-mono"
                    placeholder={attribute.type === 'boolean' ? 'true or false' : ''}
                    value={attribute.value}
                    onChange={(event) => setAttributes(attributes.map((other, place) => (place === position ? { ...other, value: event.target.value } : other)))}
                  />
                </div>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove attribute ${attribute.key || position + 1}`} onClick={() => setAttributes(attributes.filter((_, place) => place !== position))}>
                  <XIcon />
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => setAttributes([...attributes, { key: '', type: 'string', value: '' }])}>
              <PlusIcon />
              Add an attribute
            </Button>
          </div>

          <Button type="submit" disabled={preview.isPending || (source === 'version' && !/^[1-9][0-9]*$/.test(versionNumber))}>
            {preview.isPending ? 'Previewing…' : 'Preview'}
          </Button>
        </form>

        {preview.error ? (
          <p role="alert" className="text-sm text-destructive">
            {preview.error instanceof ApiError
              ? preview.error.code === 'not_found'
                ? 'This server does not answer previews yet.'
                : preview.error.message
              : 'The preview could not reach the server. Try again.'}
          </p>
        ) : null}

        {result ? (
          <div className="space-y-5" data-testid="preview-result" aria-live="polite">
            {result.answer.warnings?.length ? (
              <p className="text-[13px] text-warning">
                Treated as absent, as a fetch would: {result.answer.warnings.map((warning) => warning.path).join(', ')}.
              </p>
            ) : null}
            <section className="space-y-2" aria-labelledby="preview-values">
              <h3 id="preview-values" className="text-sm font-medium">
                Values
              </h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Parameter</TableHead>
                    <TableHead>Value</TableHead>
                    <TableHead>From</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.answer.parameters.map((parameter) => (
                    <TableRow key={parameter.key} data-testid={`preview-parameter-${parameter.key}`}>
                      <TableCell className="font-mono">{parameter.key}</TableCell>
                      <TableCell className="max-w-72 truncate font-mono" title={inlineValue(parameter.value)}>
                        {inlineValue(parameter.value)}
                      </TableCell>
                      <TableCell>
                        {parameter.source.kind === 'default' ? 'The default' : `${parameter.source.name}${parameter.source.variant ? `: ${parameter.source.variant}` : ''}`}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </section>

            {result.answer.conditions.length > 0 ? (
              <section className="space-y-2" aria-labelledby="preview-conditions">
                <h3 id="preview-conditions" className="text-sm font-medium">
                  Conditions
                </h3>
                <ul className="divide-y rounded-lg border">
                  {result.answer.conditions.map((entry) => {
                    const rule = entry.firstFalseRule === undefined ? undefined : conditions.get(entry.id)?.rules[entry.firstFalseRule];
                    return (
                      <li key={entry.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[13px]" data-testid={`preview-condition-${entry.id}`}>
                        <span className="font-medium">{entry.name}</span>
                        <Badge variant={entry.result ? 'primary' : 'muted'}>{entry.result ? 'True' : 'False'}</Badge>
                        {entry.variant ? <span>Variant {entry.variant}</span> : null}
                        {entry.notEvaluated ? <span className="text-destructive">Not evaluated: publishing would refuse this condition.</span> : null}
                        {entry.unitMissing ? <span className="text-muted-foreground">The context carries no ID for its unit.</span> : null}
                        {rule ? <span className="text-muted-foreground">First false rule: {describeRule(rule)}.</span> : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}

            <section className="space-y-1" aria-labelledby="preview-experiments">
              <h3 id="preview-experiments" className="text-sm font-medium">
                Experiments
              </h3>
              {Object.keys(result.answer.experiments).length === 0 ? (
                <p className="text-[13px] text-muted-foreground">None: this context is in no split’s population.</p>
              ) : (
                <ul className="text-[13px]">
                  {Object.entries(result.answer.experiments).map(([key, variant]) => (
                    <li key={key}>
                      <span className="font-mono">{key}</span> → <span className="font-mono">{variant}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {result.answer.problems.length > 0 ? (
              <section className="space-y-1" aria-labelledby="preview-problems">
                <h3 id="preview-problems" className="text-sm font-medium">
                  Not evaluated
                </h3>
                <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-destructive">
                  {result.answer.problems.map((problem) => (
                    <li key={`${problem.path}:${problem.code}`}>{problem.message}</li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
