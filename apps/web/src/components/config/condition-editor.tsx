import { useState, type ReactNode } from 'react';
import { PlusIcon, ShuffleIcon, TrashIcon, XIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
  checkTemplateForSave,
  CONFIG_BUILT_IN_ATTRIBUTES,
  CONFIG_LIMITS,
  CONFIG_OPERATOR_FAMILIES,
  CONFIG_PLATFORMS,
  newConditionId,
  operatorFamiliesFor,
  type ConfigCondition,
  type ConfigOperator,
  type ConfigOperatorFamily,
  type ConfigProblem,
  type ConfigRule,
  type ConfigUnit,
} from '@inlet/shared';
import { api, ApiError, type ConfigConditionBody, type ConfigDraft } from '@/lib/api';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { attributeOption, describeRule, percent, PLATFORM_LABELS, problemsAt, rebase } from './format';
import { failureMessage, type RunChange } from './parameters-tab';

type ValueType = 'string' | 'number' | 'boolean';
type RuleForm = { attribute: string; operator: ConfigOperator; text: string; list: string; unit: ConfigUnit; valueType: ValueType };
type VariantForm = { key: string; percent: string };
type Form = { name: string; kind: 'match' | 'split'; rules: RuleForm[]; experiment: string; unit: ConfigUnit; variants: VariantForm[] };

const C = 'conditions.0';
const CUSTOM = 'attributes.';
const TARGETING_WARNING = 'Targeting is not access control. Anyone with your publishable key can ask for the values of any user.';

const OPERATOR_LABELS: Record<ConfigOperator, string> = {
  exists: 'is set', notExists: 'is not set', equals: 'is', notEquals: 'is not', in: 'is one of', notIn: 'is none of',
  contains: 'contains', startsWith: 'starts with', endsWith: 'ends with',
  versionEquals: 'is version', versionLt: 'is earlier than', versionLte: 'is at most', versionGt: 'is later than', versionGte: 'is at least',
  eq: '=', neq: '≠', lt: '<', lte: '≤', gt: '>', gte: '≥', before: 'is before', after: 'is at or after',
};

/** A custom attribute's operators follow the type of its value (RC-023: a rule matches only a value of its type). */
const CUSTOM_FAMILIES: Record<ValueType, ConfigOperatorFamily[]> = {
  string: ['presence', 'equality', 'membership', 'text', 'version'],
  number: ['presence', 'membership', 'number'],
  boolean: ['presence', 'boolean', 'membership'],
};

const isCustom = (attribute: string) => attribute.startsWith(CUSTOM);

function familiesOf(rule: Pick<RuleForm, 'attribute' | 'valueType'>): readonly ConfigOperatorFamily[] {
  return isCustom(rule.attribute) ? CUSTOM_FAMILIES[rule.valueType] : operatorFamiliesFor(rule.attribute);
}

function operatorsOf(rule: Pick<RuleForm, 'attribute' | 'valueType'>): ConfigOperator[] {
  return [...new Set(familiesOf(rule).flatMap((family) => CONFIG_OPERATOR_FAMILIES[family] as readonly ConfigOperator[]))];
}

function familyOf(rule: RuleForm): ConfigOperatorFamily {
  return familiesOf(rule).find((family) => (CONFIG_OPERATOR_FAMILIES[family] as readonly string[]).includes(rule.operator)) ?? 'equality';
}

/**
 * An RFC 3339 instant as the value of a `datetime-local` input, in the browser's time zone, with
 * its seconds when it has any, so saving the condition untouched keeps the instant.
 * ponytail: milliseconds are dropped; an instant the API was given to the millisecond moves to its second.
 */
function toLocalInput(value: unknown): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60_000;
  const local = new Date(date.getTime() - offset).toISOString().slice(0, 19);
  return local.endsWith(':00') ? local.slice(0, 16) : local;
}

function ruleForm(rule?: ConfigRule): RuleForm {
  if (!rule) return { attribute: 'appVersion', operator: 'versionGte', text: '', list: '', unit: 'installation', valueType: 'string' };
  const sample = Array.isArray(rule.value) ? rule.value[0] : rule.value;
  const valueType: ValueType = typeof sample === 'number' ? 'number' : typeof sample === 'boolean' ? 'boolean' : 'string';
  const text =
    rule.attribute === 'percentage'
      ? (Number(rule.value) / 100).toFixed(2)
      : rule.attribute === 'time'
        ? toLocalInput(rule.value)
        : Array.isArray(rule.value) || rule.value === undefined
          ? ''
          : String(rule.value);
  return { attribute: rule.attribute, operator: rule.operator, text, list: Array.isArray(rule.value) ? rule.value.map(String).join('\n') : '', unit: rule.unit ?? 'installation', valueType };
}

/** A pasted list: one value per line, trimmed, without blank lines or repeats. */
const lines = (text: string) => [...new Set(text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== ''))];

function scalar(valueType: ValueType, text: string): string | number | boolean {
  if (valueType === 'boolean') return text === 'true';
  if (valueType === 'number') return text.trim() === '' || !Number.isFinite(Number(text)) ? text : Number(text);
  return text;
}

/** The form's rule as the template stores it; a value that does not convert is left for the shared checks to name. */
function ruleOf(form: RuleForm): ConfigRule {
  const rule: ConfigRule = { attribute: form.attribute, operator: form.operator };
  switch (familyOf(form)) {
    case 'presence':
      return rule;
    case 'membership':
      return { ...rule, value: lines(form.list).map((line) => (isCustom(form.attribute) ? scalar(form.valueType, line) : line)) as ConfigRule['value'] };
    case 'percentage': {
      const hundredths = Math.round(Number(form.text) * 100);
      return { ...rule, value: form.text.trim() === '' || !Number.isFinite(hundredths) ? form.text : hundredths, unit: form.unit };
    }
    case 'time': {
      const date = new Date(form.text);
      return { ...rule, value: Number.isNaN(date.getTime()) ? form.text : date.toISOString().replace('.000Z', 'Z') };
    }
    case 'number':
      return { ...rule, value: scalar('number', form.text) };
    case 'boolean':
      return { ...rule, value: form.text === 'true' };
    default:
      return { ...rule, value: form.text };
  }
}

function formOf(condition: ConfigCondition | undefined): Form {
  if (!condition) {
    return { name: '', kind: 'match', rules: [ruleForm()], experiment: '', unit: 'installation', variants: [{ key: 'control', percent: '50.00' }, { key: 'treatment', percent: '50.00' }] };
  }
  return {
    name: condition.name,
    kind: condition.kind,
    rules: condition.rules.map(ruleForm),
    experiment: condition.kind === 'split' ? condition.experiment : '',
    unit: condition.kind === 'split' ? condition.unit : 'installation',
    variants: condition.kind === 'split' ? condition.variants.map((variant) => ({ key: variant.key, percent: (variant.weight / 100).toFixed(2) })) : [{ key: 'control', percent: '50.00' }, { key: 'treatment', percent: '50.00' }],
  };
}

const weightOf = (text: string) => Math.round(Number(text) * 100);

function candidateOf(id: string, form: Form): ConfigConditionBody {
  const rules = form.rules.map(ruleOf);
  if (form.kind === 'match') return { id, name: form.name, kind: 'match', rules };
  return {
    id,
    name: form.name,
    kind: 'split',
    experiment: form.experiment,
    unit: form.unit,
    rules,
    variants: form.variants.map((variant) => ({ key: variant.key, weight: Number.isFinite(weightOf(variant.percent)) ? weightOf(variant.percent) : 0 })),
  };
}

/**
 * A condition's editor (PRD 8.1, RC-020 to RC-027): rules built from an attribute (built in or
 * `attributes.<key>`), an operator the attribute accepts and a value; a list pasted one value per
 * line; a percentage with two decimals and its unit; a date-time for a time rule; and for a split,
 * the population, variants with weights, the experiment key, the unit and Reshuffle.
 */
export function ConditionEditor({
  databaseId,
  draft,
  conditionId,
  readOnly,
  run,
  onClose,
}: {
  databaseId: string;
  draft: ConfigDraft;
  conditionId: string | null;
  readOnly: boolean;
  run: RunChange;
  onClose: () => void;
}) {
  const index = conditionId === null ? -1 : draft.template.conditions.findIndex((condition) => condition.id === conditionId);
  const original = index === -1 ? undefined : draft.template.conditions[index];
  const [id] = useState(() => conditionId ?? newConditionId());
  const [form, setForm] = useState<Form>(() => formOf(original));
  const [serverProblems, setServerProblems] = useState<ConfigProblem[]>([]);
  const [saving, setSaving] = useState(false);
  const [reshuffling, setReshuffling] = useState(false);
  const [touched, setTouched] = useState(original !== undefined);
  const set = (patch: Partial<Form>) => {
    setTouched(true);
    setForm((current) => ({ ...current, ...patch }));
  };
  const setRule = (position: number, patch: Partial<RuleForm>) => set({ rules: form.rules.map((rule, other) => (other === position ? { ...rule, ...patch } : rule)) });

  const candidate = candidateOf(id, form);
  // An empty name fails the shape check, which would hide every rule's problem: check with a stand-in and say so apart.
  const checked = checkTemplateForSave({ parameters: [], conditions: [{ ...candidate, name: form.name || 'x', salt: original?.salt ?? 'AAAAAAAAAAAAAAAA' }] });
  const others = draft.template.conditions.filter((condition) => condition.id !== id);
  const local: ConfigProblem[] = [
    ...(form.name.trim() === '' ? [{ path: `${C}.name`, code: 'name_required', message: 'Name the condition.' }] : []),
    ...(checked.ok ? [] : checked.problems),
    ...(others.some((condition) => condition.name === form.name) ? [{ path: `${C}.name`, code: 'duplicate_name', message: `Another condition is named “${form.name}”.` }] : []),
    ...(form.kind === 'split' && others.some((condition) => condition.kind === 'split' && condition.experiment === form.experiment)
      ? [{ path: `${C}.experiment`, code: 'duplicate_experiment', message: `Another split uses the experiment key “${form.experiment}”.` }]
      : []),
  ];
  // A new condition shows its problems once something is typed, not on opening.
  const shown = [...(touched ? local : []), ...serverProblems, ...(original ? rebase(draft.problems, 'conditions', index) : [])];
  const at = (field: string) => [...new Set(problemsAt(shown, `${C}.${field}`))];
  const general = shown.filter((problem) => !['name', 'kind', 'rules', 'experiment', 'unit', 'variants'].some((field) => problem.path.startsWith(`${C}.${field}`)));
  const canSave = !readOnly && local.length === 0 && !saving;
  const total = form.variants.reduce((sum, variant) => sum + (Number.isFinite(weightOf(variant.percent)) ? weightOf(variant.percent) : 0), 0);

  async function submit() {
    setSaving(true);
    setServerProblems([]);
    try {
      await run({
        send: () => api.setConfigCondition(databaseId, candidate),
        apply: (template, answer) => ({
          ...template,
          conditions: template.conditions.some((condition) => condition.id === id)
            ? template.conditions.map((condition) => (condition.id === id ? answer.condition! : condition))
            : [...template.conditions, answer.condition!],
        }),
      });
      toast.success(`${form.name} saved.`);
      onClose();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'config_template_invalid') {
        setServerProblems(rebase(error.details as ConfigProblem[], 'conditions', index === -1 ? draft.template.conditions.length : index));
        if (error.details.length === 0) toast.error(error.message);
      } else toast.error(failureMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function reshuffle() {
    try {
      await run({
        send: () => api.reshuffleConfigCondition(databaseId, id),
        apply: (template, answer) => ({ ...template, conditions: template.conditions.map((condition) => (condition.id === id ? answer.condition! : condition)) }),
      });
      toast.success(`${form.name} reshuffled. Publish to reassign the buckets.`);
      setReshuffling(false);
    } catch (error) {
      toast.error(failureMessage(error));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{original ? original.name : 'New condition'}</DialogTitle>
          <DialogDescription>
            {readOnly
              ? 'You can read this condition; a Creator or Admin can change it.'
              : form.kind === 'match'
                ? 'True when every rule is true.'
                : 'Assigns each unit of its population one variant, by weight.'}
          </DialogDescription>
        </DialogHeader>

        <form
          id="condition-form"
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave) void submit();
          }}
        >
          <fieldset disabled={readOnly} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
              <Field label="Name" htmlFor="condition-name" problems={at('name')}>
                <Input id="condition-name" value={form.name} maxLength={CONFIG_LIMITS.conditionNameMaxLength} autoComplete="off" onChange={(event) => set({ name: event.target.value })} />
              </Field>
              <Field label="Kind" htmlFor="condition-kind" problems={at('kind')}>
                <Select value={form.kind} disabled={readOnly} onValueChange={(kind) => set({ kind: kind as Form['kind'] })}>
                  <SelectTrigger id="condition-kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="match">Match</SelectItem>
                    <SelectItem value="split">Split</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <section className="space-y-3" aria-labelledby="rules-heading">
              <h3 id="rules-heading" className="text-sm font-medium">
                {form.kind === 'match' ? 'Rules (all must be true)' : 'Population (optional; all rules must be true)'}
              </h3>
              {form.rules.map((rule, position) => (
                <RuleRow
                  key={position}
                  position={position}
                  rule={rule}
                  readOnly={readOnly}
                  problems={at(`rules.${position}`)}
                  onChange={(patch) => setRule(position, patch)}
                  onRemove={() => set({ rules: form.rules.filter((_, other) => other !== position) })}
                />
              ))}
              {!readOnly && form.rules.length < CONFIG_LIMITS.rulesPerConditionMax ? (
                <Button type="button" variant="outline" size="sm" onClick={() => set({ rules: [...form.rules, ruleForm()] })}>
                  <PlusIcon />
                  Add a rule
                </Button>
              ) : null}
              {at('rules')
                .filter((message) => !form.rules.some((_, position) => at(`rules.${position}`).includes(message)))
                .map((message) => (
                  <p key={message} className="text-xs text-destructive">
                    {message}
                  </p>
                ))}
            </section>

            {form.kind === 'split' ? (
              <section className="space-y-3" aria-labelledby="split-heading">
                <h3 id="split-heading" className="text-sm font-medium">
                  Split
                </h3>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Experiment key" htmlFor="condition-experiment" problems={at('experiment')}>
                    <Input id="condition-experiment" className="font-mono" value={form.experiment} autoComplete="off" onChange={(event) => set({ experiment: event.target.value })} />
                  </Field>
                  <Field label="Unit" htmlFor="condition-unit" problems={at('unit')}>
                    <UnitSelect id="condition-unit" value={form.unit} disabled={readOnly} onChange={(unit) => set({ unit })} />
                  </Field>
                </div>
                <div className="space-y-2">
                  {form.variants.map((variant, position) => (
                    <div key={position} className="flex items-end gap-2">
                      <div className="flex-1 space-y-1.5">
                        <Label htmlFor={`variant-key-${position}`}>Variant {position + 1}</Label>
                        <Input
                          id={`variant-key-${position}`}
                          className="font-mono"
                          value={variant.key}
                          onChange={(event) => set({ variants: form.variants.map((other, place) => (place === position ? { ...other, key: event.target.value } : other)) })}
                        />
                      </div>
                      <div className="w-32 space-y-1.5">
                        <Label htmlFor={`variant-weight-${position}`}>Weight (%)</Label>
                        <Input
                          id={`variant-weight-${position}`}
                          type="number"
                          min={0}
                          max={100}
                          step={0.01}
                          className="numeric"
                          value={variant.percent}
                          onChange={(event) => set({ variants: form.variants.map((other, place) => (place === position ? { ...other, percent: event.target.value } : other)) })}
                        />
                      </div>
                      {!readOnly && form.variants.length > CONFIG_LIMITS.variantsMin ? (
                        <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove variant ${variant.key || position + 1}`} onClick={() => set({ variants: form.variants.filter((_, place) => place !== position) })}>
                          <XIcon />
                        </Button>
                      ) : null}
                    </div>
                  ))}
                  <p className={total === CONFIG_LIMITS.weightTotal ? 'text-xs text-muted-foreground' : 'text-xs text-destructive'} data-testid="weights-total">
                    {total === CONFIG_LIMITS.weightTotal
                      ? 'The weights sum to 100.00%.'
                      : `The weights sum to ${percent(total)}; ${total < CONFIG_LIMITS.weightTotal ? `${percent(CONFIG_LIMITS.weightTotal - total)} remains` : `${percent(total - CONFIG_LIMITS.weightTotal)} too many`}. Publishing needs 100.00%.`}
                  </p>
                  {at('variants').map((message) => (
                    <p key={message} className="text-xs text-destructive">
                      {message}
                    </p>
                  ))}
                  {!readOnly && form.variants.length < CONFIG_LIMITS.variantsMax ? (
                    <Button type="button" variant="outline" size="sm" onClick={() => set({ variants: [...form.variants, { key: `variant_${form.variants.length + 1}`, percent: '0.00' }] })}>
                      <PlusIcon />
                      Add a variant
                    </Button>
                  ) : null}
                </div>
              </section>
            ) : null}
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
            <Button type="button" variant="ghost" className="mr-auto" onClick={() => setReshuffling(true)}>
              <ShuffleIcon />
              Reshuffle
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={onClose}>
            {readOnly ? 'Close' : 'Cancel'}
          </Button>
          {!readOnly ? (
            <Button type="submit" form="condition-form" disabled={!canSave}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          ) : null}
        </DialogFooter>

        {/* RC-027: Reshuffle says what it does and asks first. */}
        <ConfirmDialog
          open={reshuffling}
          onOpenChange={setReshuffling}
          title={`Reshuffle ${original?.name ?? 'this condition'}?`}
          confirmLabel="Reshuffle"
          description={
            <p>
              Reshuffle draws a new salt, which reassigns every unit’s bucket for this condition once published: a percentage reaches different installations or
              users, and a split assigns its variants afresh.
            </p>
          }
          onConfirm={() => void reshuffle()}
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
        <ul className="space-y-0.5 text-xs text-destructive">
          {problems.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function UnitSelect({ id, value, disabled, onChange }: { id: string; value: ConfigUnit; disabled: boolean; onChange: (unit: ConfigUnit) => void }) {
  return (
    <Select value={value} disabled={disabled} onValueChange={(next) => onChange(next as ConfigUnit)}>
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="installation">Installation</SelectItem>
        <SelectItem value="user">User</SelectItem>
      </SelectContent>
    </Select>
  );
}

const ATTRIBUTE_CHOICES = [...CONFIG_BUILT_IN_ATTRIBUTES, CUSTOM];

function RuleRow({
  position,
  rule,
  readOnly,
  problems,
  onChange,
  onRemove,
}: {
  position: number;
  rule: RuleForm;
  readOnly: boolean;
  problems: string[];
  onChange: (patch: Partial<RuleForm>) => void;
  onRemove: () => void;
}) {
  const prefix = `rule-${position}`;
  const custom = isCustom(rule.attribute);
  const family = familyOf(rule);
  const operators = operatorsOf(rule);
  const reset = (next: Pick<RuleForm, 'attribute' | 'valueType'>) => ({ ...next, operator: operatorsOf(next)[0]!, text: next.valueType === 'boolean' ? 'true' : '', list: '' });
  const values = lines(rule.list);
  const words = describeRule(ruleOf(rule));

  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="rule">
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-44 space-y-1.5">
          <Label htmlFor={`${prefix}-attribute`}>Attribute</Label>
          <Select value={custom ? CUSTOM : rule.attribute} disabled={readOnly} onValueChange={(attribute) => onChange(reset({ attribute, valueType: 'string' }))}>
            <SelectTrigger id={`${prefix}-attribute`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ATTRIBUTE_CHOICES.map((attribute) => (
                <SelectItem key={attribute} value={attribute}>
                  {attribute === CUSTOM ? 'Custom attribute' : attributeOption(attribute)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {custom ? (
          <>
            <div className="w-36 space-y-1.5">
              <Label htmlFor={`${prefix}-key`}>Attribute key</Label>
              <Input id={`${prefix}-key`} className="font-mono" value={rule.attribute.slice(CUSTOM.length)} onChange={(event) => onChange({ attribute: `${CUSTOM}${event.target.value}` })} />
            </div>
            <div className="w-28 space-y-1.5">
              <Label htmlFor={`${prefix}-type`}>Value type</Label>
              <Select value={rule.valueType} disabled={readOnly} onValueChange={(valueType) => onChange(reset({ attribute: rule.attribute, valueType: valueType as ValueType }))}>
                <SelectTrigger id={`${prefix}-type`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="string">Text</SelectItem>
                  <SelectItem value="number">Number</SelectItem>
                  <SelectItem value="boolean">Boolean</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </>
        ) : null}
        {family !== 'percentage' ? (
          <div className="w-40 space-y-1.5">
            <Label htmlFor={`${prefix}-operator`}>Operator</Label>
            <Select value={rule.operator} disabled={readOnly} onValueChange={(operator) => onChange({ operator: operator as ConfigOperator })}>
              <SelectTrigger id={`${prefix}-operator`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {operators.map((operator) => (
                  <SelectItem key={operator} value={operator}>
                    {OPERATOR_LABELS[operator]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <RuleValue prefix={prefix} rule={rule} family={family} readOnly={readOnly} onChange={onChange} />
        {!readOnly ? (
          <Button type="button" variant="ghost" size="icon-sm" className="ml-auto" aria-label={`Remove rule ${position + 1}`} onClick={onRemove}>
            <TrashIcon />
          </Button>
        ) : null}
      </div>
      {family === 'membership' ? (
        <div className="space-y-1.5">
          <Label htmlFor={`${prefix}-list`}>Values, one per line</Label>
          <Textarea id={`${prefix}-list`} rows={4} className="font-mono text-xs" value={rule.list} onChange={(event) => onChange({ list: event.target.value })} />
          <p className={values.length > CONFIG_LIMITS.listValuesMax ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'} data-testid={`${prefix}-count`}>
            {values.length === 1 ? '1 value' : `${values.length.toLocaleString('en-US')} values`}
            {values.length > CONFIG_LIMITS.listValuesMax ? `; a list holds at most ${CONFIG_LIMITS.listValuesMax.toLocaleString('en-US')}.` : ''}
            {rule.attribute === 'platform' ? ` Platforms: ${CONFIG_PLATFORMS.map((platform) => `${platform} (${PLATFORM_LABELS[platform]})`).join(', ')}.` : ''}
          </p>
        </div>
      ) : null}
      {problems.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid={`${prefix}-words`}>
          {words.charAt(0).toUpperCase() + words.slice(1)}
        </p>
      ) : null}
      {rule.attribute === 'userId' || rule.attribute === 'installationId' ? <p className="text-xs text-warning">{TARGETING_WARNING}</p> : null}
      {problems.length > 0 ? (
        <ul className="space-y-0.5 text-xs text-destructive">
          {problems.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function RuleValue({ prefix, rule, family, readOnly, onChange }: { prefix: string; rule: RuleForm; family: ConfigOperatorFamily; readOnly: boolean; onChange: (patch: Partial<RuleForm>) => void }) {
  if (family === 'presence' || family === 'membership') return null;
  if (family === 'percentage') {
    return (
      <>
        <div className="w-32 space-y-1.5">
          <Label htmlFor={`${prefix}-percent`}>Percentage</Label>
          <Input id={`${prefix}-percent`} type="number" min={0} max={100} step={0.01} className="numeric" value={rule.text} onChange={(event) => onChange({ text: event.target.value })} />
        </div>
        <div className="w-36 space-y-1.5">
          <Label htmlFor={`${prefix}-unit`}>Of</Label>
          <UnitSelect id={`${prefix}-unit`} value={rule.unit} disabled={readOnly} onChange={(unit) => onChange({ unit })} />
        </div>
      </>
    );
  }
  if (family === 'time') {
    return (
      <div className="w-56 space-y-1.5">
        <Label htmlFor={`${prefix}-time`}>Date and time (your time zone)</Label>
        <Input id={`${prefix}-time`} type="datetime-local" step={rule.text.length > 16 ? 1 : undefined} value={rule.text} onChange={(event) => onChange({ text: event.target.value })} />
      </div>
    );
  }
  if (family === 'boolean') {
    return (
      <div className="w-28 space-y-1.5">
        <Label htmlFor={`${prefix}-value`}>Value</Label>
        <Select value={rule.text === 'false' ? 'false' : 'true'} disabled={readOnly} onValueChange={(text) => onChange({ text })}>
          <SelectTrigger id={`${prefix}-value`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true">true</SelectItem>
            <SelectItem value="false">false</SelectItem>
          </SelectContent>
        </Select>
      </div>
    );
  }
  return (
    <div className="min-w-40 flex-1 space-y-1.5">
      <Label htmlFor={`${prefix}-value`}>Value</Label>
      <Input
        id={`${prefix}-value`}
        type={family === 'number' ? 'number' : 'text'}
        step="any"
        className="font-mono"
        value={rule.text}
        placeholder={family === 'version' ? '1.4.0' : undefined}
        onChange={(event) => onChange({ text: event.target.value })}
      />
    </div>
  );
}
