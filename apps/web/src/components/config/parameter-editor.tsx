import { useId, useState, type ReactNode } from 'react';
import { TrashIcon, XIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
  checkTemplateForSave,
  CONFIG_LIMITS,
  CONFIG_PARAMETER_TYPES,
  type ConfigParameter,
  type ConfigParameterType,
  type ConfigProblem,
} from '@inlet/shared';
import { api, ApiError, type ConfigDraft } from '@/lib/api';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { emptyText, problemsAt, rebase, textToValue, TYPE_LABELS, valueToText } from './format';
import { JsonEditor } from './json-editor';
import { failureMessage, type RunChange } from './parameters-tab';

type Conditional = { condition: string; variant?: string; text: string };
type Form = { key: string; type: ConfigParameterType; description: string; live: boolean; defaultText: string; schemaText: string; conditional: Conditional[] };

const FIELDS = ['key', 'type', 'description', 'live', 'default', 'schema', 'conditional'];
const P = 'parameters.0';

function formOf(parameter: ConfigParameter | undefined): Form {
  if (!parameter) return { key: '', type: 'boolean', description: '', live: false, defaultText: 'false', schemaText: '', conditional: [] };
  return {
    key: parameter.key,
    type: parameter.type,
    description: parameter.description ?? '',
    live: parameter.live,
    defaultText: valueToText(parameter.type, parameter.default),
    schemaText: parameter.schema === undefined ? '' : JSON.stringify(parameter.schema, null, 2),
    conditional: parameter.conditional.map((entry) => ({ condition: entry.condition, ...(entry.variant !== undefined && { variant: entry.variant }), text: valueToText(parameter.type, entry.value) })),
  };
}

/** The form as a parameter, or null while a value does not parse (each field shows why). */
function candidateOf(form: Form): ConfigParameter | null {
  const value = textToValue(form.type, form.defaultText);
  if (!value.ok) return null;
  let schema: unknown;
  if (form.type === 'json' && form.schemaText.trim() !== '') {
    const parsed = textToValue('json', form.schemaText);
    if (!parsed.ok) return null;
    schema = parsed.value;
  }
  const conditional: ConfigParameter['conditional'] = [];
  for (const entry of form.conditional) {
    const parsed = textToValue(form.type, entry.text);
    if (!parsed.ok) return null;
    conditional.push({ condition: entry.condition, ...(entry.variant !== undefined && { variant: entry.variant }), value: parsed.value });
  }
  return {
    key: form.key,
    type: form.type,
    ...(form.description.trim() !== '' && { description: form.description }),
    live: form.live,
    default: value.value,
    ...(schema !== undefined && { schema: schema as ConfigParameter['schema'] }),
    conditional,
  };
}

/**
 * A parameter's editor (PRD 8.1): key, type, description, live switch, the default in an editor
 * suited to the type, the schema of a JSON parameter and the conditional values, one per match
 * condition or split variant. The shared save checks (RC-019) run as it is typed; Save sends one
 * per-part change (RC-051). A refused or failed save keeps the edit and shows why.
 */
export function ParameterEditor({
  databaseId,
  draft,
  parameterKey,
  readOnly,
  run,
  onClose,
}: {
  databaseId: string;
  draft: ConfigDraft;
  parameterKey: string | null;
  readOnly: boolean;
  run: RunChange;
  onClose: () => void;
}) {
  const index = parameterKey === null ? -1 : draft.template.parameters.findIndex((parameter) => parameter.key === parameterKey);
  const original = index === -1 ? undefined : draft.template.parameters[index];
  const [form, setForm] = useState<Form>(() => formOf(original));
  const [serverProblems, setServerProblems] = useState<ConfigProblem[]>([]);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [touched, setTouched] = useState(original !== undefined);
  // The new key of a rename whose deletion of the old one failed: Save again finishes it.
  const [renamed, setRenamed] = useState<string | null>(null);
  const set = (patch: Partial<Form>) => {
    setTouched(true);
    setForm((current) => ({ ...current, ...patch }));
  };

  const candidate = candidateOf(form);
  const checked = candidate ? checkTemplateForSave({ parameters: [candidate], conditions: [] }) : null;
  const duplicate = form.key !== parameterKey && form.key !== renamed && draft.template.parameters.some((parameter) => parameter.key === form.key);
  const local: ConfigProblem[] = [
    ...(checked && !checked.ok ? checked.problems : []),
    ...(duplicate ? [{ path: `${P}.key`, code: 'duplicate_key', message: `The parameter key “${form.key}” is used by another parameter.` }] : []),
  ];
  // What publishing would refuse about the stored parameter (RC-050), then what the last save refused.
  // A new parameter shows its problems once something is typed, not on opening.
  const shown = [...(touched ? local : []), ...serverProblems, ...(original ? rebase(draft.problems, 'parameters', index) : [])];
  const at = (field: string) => [...new Set(problemsAt(shown, `${P}.${field}`))];
  // A value's problems by its condition and variant, not its position, which changes as values are removed.
  const atValue = (entry: Conditional) => [...new Set(problemsAt(shown.filter((problem) => problem.condition === entry.condition && problem.variant === entry.variant), `${P}.conditional`))];
  const general = shown.filter((problem) => !FIELDS.some((field) => problem.path.startsWith(`${P}.${field}`)));
  const canSave = !readOnly && candidate !== null && local.length === 0 && !saving;

  // RC-013: one value per match condition and one per variant of a split, each once.
  const used = new Set(form.conditional.map((entry) => `${entry.condition}:${entry.variant ?? ''}`));
  const targets = draft.template.conditions.flatMap((condition): Array<{ id: string; condition: string; variant?: string; label: string }> =>
    condition.kind === 'match'
      ? [{ id: `${condition.id}:`, condition: condition.id, label: condition.name }]
      : condition.variants.map((variant) => ({ id: `${condition.id}:${variant.key}`, condition: condition.id, variant: variant.key, label: `${condition.name}: ${variant.key}` })),
  );
  const names = new Map(draft.template.conditions.map((condition) => [condition.id, condition.name]));

  async function submit() {
    if (!candidate) return;
    setSaving(true);
    setServerProblems([]);
    try {
      const stored = (template: ConfigDraft['template'], parameter: ConfigParameter) =>
        template.parameters.some((existing) => existing.key === parameter.key)
          ? template.parameters.map((existing) => (existing.key === parameter.key ? parameter : existing))
          : [...template.parameters, parameter];
      await run({ send: () => api.setConfigParameter(databaseId, candidate), apply: (template, answer) => ({ ...template, parameters: stored(template, answer.parameter!) }) });
      // A rename is a create and a delete (the API has no rename): the old key goes once the new one is stored.
      if (parameterKey !== null && parameterKey !== candidate.key) {
        setRenamed(candidate.key);
        await run({
          send: () => api.deleteConfigParameter(databaseId, parameterKey),
          apply: (template) => ({ ...template, parameters: template.parameters.filter((parameter) => parameter.key !== parameterKey) }),
        });
      }
      toast.success(`${candidate.key} saved.`);
      onClose();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'config_template_invalid') {
        const position = draft.template.parameters.findIndex((parameter) => parameter.key === candidate.key);
        setServerProblems(rebase(error.details as ConfigProblem[], 'parameters', position === -1 ? draft.template.parameters.length : position));
        if (error.details.length === 0) toast.error(error.message);
      } else toast.error(failureMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (parameterKey === null) return;
    try {
      await run({
        send: () => api.deleteConfigParameter(databaseId, parameterKey),
        apply: (template) => ({ ...template, parameters: template.parameters.filter((parameter) => parameter.key !== parameterKey) }),
      });
      toast.success(`${parameterKey} deleted.`);
      onClose();
    } catch (error) {
      toast.error(failureMessage(error));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{original ? original.key : 'New parameter'}</DialogTitle>
          <DialogDescription>
            {readOnly ? 'You can read this parameter; a Creator or Admin can change it.' : 'Saved to the draft; apps receive it once it is published.'}
          </DialogDescription>
        </DialogHeader>

        <form
          id="parameter-form"
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave) void submit();
          }}
        >
          <fieldset disabled={readOnly} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
              <Field label="Key" htmlFor="parameter-key" problems={at('key')}>
                <Input
                  id="parameter-key"
                  className="font-mono"
                  value={form.key}
                  maxLength={CONFIG_LIMITS.parameterKeyMaxLength + 1}
                  autoComplete="off"
                  aria-invalid={at('key').length > 0}
                  onChange={(event) => set({ key: event.target.value })}
                />
              </Field>
              <Field label="Type" htmlFor="parameter-type" problems={at('type')}>
                <Select
                  value={form.type}
                  disabled={readOnly}
                  onValueChange={(next) => {
                    const type = next as ConfigParameterType;
                    if (type === form.type) return;
                    set({ type, defaultText: emptyText(type), schemaText: '', conditional: form.conditional.map((entry) => ({ ...entry, text: emptyText(type) })) });
                  }}
                >
                  <SelectTrigger id="parameter-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CONFIG_PARAMETER_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {TYPE_LABELS[type]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <Field label="Description" htmlFor="parameter-description" problems={at('description')}>
              <Textarea
                id="parameter-description"
                rows={2}
                value={form.description}
                maxLength={CONFIG_LIMITS.descriptionMaxLength}
                onChange={(event) => set({ description: event.target.value })}
              />
            </Field>

            <div className="flex items-start gap-3">
              <Switch id="parameter-live" checked={form.live} onCheckedChange={(live) => set({ live })} />
              <div className="space-y-0.5">
                <Label htmlFor="parameter-live">Live</Label>
                <p className="text-xs text-muted-foreground">Apps apply a change to it as soon as they fetch it, not at their next launch: for a kill switch.</p>
              </div>
            </div>

            <ValueField label="Default value" type={form.type} text={form.defaultText} onChange={(defaultText) => set({ defaultText })} problems={at('default')} />

            {form.type === 'json' ? (
              <JsonEditor label="Schema (optional)" optional value={form.schemaText} onChange={(schemaText) => set({ schemaText })} problems={at('schema')} />
            ) : null}

            <section className="space-y-3" aria-labelledby="conditional-heading">
              <h3 id="conditional-heading" className="text-sm font-medium">
                Conditional values
              </h3>
              {form.conditional.length === 0 ? <p className="text-xs text-muted-foreground">None: every app receives the default.</p> : null}
              {form.conditional.map((entry, position) => {
                const label = `${names.get(entry.condition) ?? entry.condition}${entry.variant ? `: ${entry.variant}` : ''}`;
                return (
                  <div key={`${entry.condition}:${entry.variant ?? ''}`} className="space-y-2 rounded-md border p-3" data-testid="conditional-value">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{label}</span>
                      {!readOnly ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="ml-auto"
                          aria-label={`Remove the value under ${label}`}
                          onClick={() => set({ conditional: form.conditional.filter((_, other) => other !== position) })}
                        >
                          <XIcon />
                        </Button>
                      ) : null}
                    </div>
                    <ValueField
                      label={`Value under ${label}`}
                      type={form.type}
                      text={entry.text}
                      onChange={(text) => set({ conditional: form.conditional.map((other, place) => (place === position ? { ...other, text } : other)) })}
                      problems={atValue(entry)}
                    />
                  </div>
                );
              })}
              {!readOnly ? (
                targets.some((target) => !used.has(target.id)) ? (
                  <Select
                    value=""
                    onValueChange={(id) => {
                      const target = targets.find((entry) => entry.id === id);
                      if (!target) return;
                      set({ conditional: [...form.conditional, { condition: target.condition, ...(target.variant !== undefined && { variant: target.variant }), text: form.defaultText }] });
                    }}
                  >
                    <SelectTrigger className="w-72" aria-label="Add a value under a condition">
                      <SelectValue placeholder="Add a value under…" />
                    </SelectTrigger>
                    <SelectContent>
                      {targets
                        .filter((target) => !used.has(target.id))
                        .map((target) => (
                          <SelectItem key={target.id} value={target.id}>
                            {target.label}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                ) : draft.template.conditions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Add a condition in the Conditions view to give this parameter another value for some apps.</p>
                ) : null
              ) : null}
            </section>
          </fieldset>

          {general.length > 0 ? (
            <ul className="space-y-0.5 text-xs text-destructive" role="alert">
              {[...new Set(general.map((problem) => problem.message))].map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          ) : null}
        </form>

        <DialogFooter>
          {original && !readOnly ? (
            <Button type="button" variant="ghost" className="mr-auto text-destructive" onClick={() => setDeleting(true)}>
              <TrashIcon />
              Delete parameter
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={onClose}>
            {readOnly ? 'Close' : 'Cancel'}
          </Button>
          {!readOnly ? (
            <Button type="submit" form="parameter-form" disabled={!canSave}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          ) : null}
        </DialogFooter>

        <ConfirmDialog
          open={deleting}
          onOpenChange={setDeleting}
          title={`Delete ${parameterKey}?`}
          description={<p>Apps that read it will use their in-app default once the draft is published.</p>}
          onConfirm={() => void remove()}
        />
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, htmlFor, problems, children }: { label: string; htmlFor: string; problems: string[]; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {problems.length > 0 ? (
        <ul className="space-y-0.5 text-xs text-destructive" data-testid={`${htmlFor}-problems`}>
          {problems.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The editor suited to the type (8.1): a text field, a number field, a switch or the JSON editor. */
function ValueField({ label, type, text, onChange, problems }: { label: string; type: ConfigParameterType; text: string; onChange: (text: string) => void; problems: string[] }) {
  // A condition's name may be in any script, so the id cannot be derived from the label.
  const id = useId();
  if (type === 'json') return <JsonEditor label={label} value={text} onChange={onChange} problems={problems} />;
  if (type === 'boolean') {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-3">
          <Switch id={id} checked={text === 'true'} onCheckedChange={(checked) => onChange(String(checked))} />
          <Label htmlFor={id}>{label}</Label>
          <span className="font-mono text-xs text-muted-foreground">{text === 'true' ? 'true' : 'false'}</span>
        </div>
        {problems.length > 0 ? <p className="text-xs text-destructive">{problems.join(' ')}</p> : null}
      </div>
    );
  }
  const parsed = textToValue(type, text);
  const messages = [...(parsed.ok ? [] : [parsed.error]), ...problems];
  return (
    <Field label={label} htmlFor={id} problems={messages}>
      <Input
        id={id}
        type={type === 'number' ? 'number' : 'text'}
        step="any"
        className="font-mono"
        value={text}
        aria-invalid={messages.length > 0}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}
