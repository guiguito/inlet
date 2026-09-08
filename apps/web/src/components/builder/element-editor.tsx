import { newId, LIMITS, type ChoiceOption, type FormElement } from '@inlet/shared';
import {
  ChevronDownIcon,
  ChevronUpIcon,
  CopyIcon,
  GripVerticalIcon,
  PlusIcon,
  TrashIcon,
  XIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

/**
 * The editor for one element (FR-031 to FR-049).
 *
 * Every control writes the whole element back, so the builder holds one definition in
 * state and autosaves it. There is no per-field mutation path to keep in sync.
 */

const TYPE_LABEL: Record<FormElement['type'], string> = {
  title: 'Title',
  subtitle: 'Subtitle',
  body_text: 'Body text',
  choice: 'Multiple choice',
  text: 'Free text',
  email: 'Email',
  screenshot: 'Screenshot',
};

export function ElementEditor({
  element,
  index,
  count,
  problems,
  onChange,
  onMove,
  onDuplicate,
  onRemove,
}: {
  element: FormElement;
  index: number;
  count: number;
  problems: string[];
  onChange: (next: FormElement) => void;
  onMove: (direction: -1 | 1) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const isQuestion = element.type !== 'title' && element.type !== 'subtitle' && element.type !== 'body_text';

  return (
    <Card data-testid={`element-${element.id}`} className={problems.length > 0 ? 'border-destructive/50' : ''}>
      <CardContent className="space-y-4 p-4">
        <div className="flex items-center gap-2">
          <GripVerticalIcon className="size-4 shrink-0 text-muted-foreground/50" aria-hidden="true" />
          <Badge variant={isQuestion ? 'primary' : 'muted'}>{TYPE_LABEL[element.type]}</Badge>
          {isQuestion ? (
            <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={element.required}
                onCheckedChange={(required) => onChange({ ...element, required })}
                // Names the question it governs, so a screen-reader user hears which
                // switch they are on rather than "Question is required" five times.
                aria-label={`${element.label.trim() || TYPE_LABEL[element.type]} is required`}
              />
              Required
            </label>
          ) : (
            <span className="ml-auto" />
          )}

          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onMove(-1)}
              disabled={index === 0}
              aria-label="Move up"
            >
              <ChevronUpIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onMove(1)}
              disabled={index === count - 1}
              aria-label="Move down"
            >
              <ChevronDownIcon />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={onDuplicate} aria-label="Duplicate">
              <CopyIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onRemove}
              aria-label="Remove element"
              className="text-muted-foreground hover:text-destructive"
            >
              <TrashIcon />
            </Button>
          </div>
        </div>

        <Fields element={element} onChange={onChange} />

        {problems.length > 0 ? (
          <ul className="space-y-1 text-xs text-destructive">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : null}

        <p className="font-mono text-[11px] text-muted-foreground/70">{element.id}</p>
      </CardContent>
    </Card>
  );
}

function Fields({
  element,
  onChange,
}: {
  element: FormElement;
  onChange: (next: FormElement) => void;
}) {
  if (element.type === 'title' || element.type === 'subtitle' || element.type === 'body_text') {
    return (
      <div className="space-y-1.5">
        <Label htmlFor={`${element.id}-text`}>Text</Label>
        {element.type === 'body_text' ? (
          <Textarea
            id={`${element.id}-text`}
            value={element.text}
            maxLength={LIMITS.bodyTextMaxLength}
            placeholder="Explain anything the respondent needs to know."
            onChange={(event) => onChange({ ...element, text: event.target.value })}
          />
        ) : (
          <Input
            id={`${element.id}-text`}
            value={element.text}
            maxLength={LIMITS.bodyTextMaxLength}
            placeholder={element.type === 'title' ? 'Tell us how it went' : 'A short subtitle'}
            onChange={(event) => onChange({ ...element, text: event.target.value })}
          />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor={`${element.id}-label`}>Question</Label>
        <Input
          id={`${element.id}-label`}
          value={element.label}
          maxLength={LIMITS.labelMaxLength}
          placeholder="What should we fix first?"
          onChange={(event) => onChange({ ...element, label: event.target.value })}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${element.id}-helper`}>Helper text</Label>
        <Input
          id={`${element.id}-helper`}
          value={element.helperText ?? ''}
          maxLength={LIMITS.helperTextMaxLength}
          placeholder="Optional. Shown under the question."
          onChange={(event) =>
            onChange({
              ...element,
              helperText: event.target.value === '' ? undefined : event.target.value,
            })
          }
        />
      </div>

      {element.type === 'choice' ? <ChoiceFields element={element} onChange={onChange} /> : null}
      {element.type === 'text' ? <TextFields element={element} onChange={onChange} /> : null}
      {element.type === 'email' ? (
        <div className="space-y-1.5">
          <Label htmlFor={`${element.id}-placeholder`}>Placeholder</Label>
          <Input
            id={`${element.id}-placeholder`}
            value={element.placeholder ?? ''}
            maxLength={LIMITS.placeholderMaxLength}
            placeholder="you@example.com"
            onChange={(event) =>
              onChange({
                ...element,
                placeholder: event.target.value === '' ? undefined : event.target.value,
              })
            }
          />
          <p className="text-xs text-muted-foreground">
            Inlet adds no disclosure text of its own. Add a body-text element around this question
            if you want to explain why you are asking.
          </p>
        </div>
      ) : null}
      {element.type === 'screenshot' ? (
        <div className="space-y-1.5">
          <Label htmlFor={`${element.id}-max`}>Maximum screenshots</Label>
          <Input
            id={`${element.id}-max`}
            type="number"
            min={1}
            max={LIMITS.screenshotQuestionMaxCount}
            value={element.maxCount}
            className="w-24"
            onChange={(event) =>
              onChange({
                ...element,
                maxCount: clamp(
                  Number(event.target.value) || 1,
                  1,
                  LIMITS.screenshotQuestionMaxCount,
                ),
              })
            }
          />
          <p className="text-xs text-muted-foreground">
            JPEG, PNG and WebP up to{' '}
            {Math.floor(LIMITS.attachmentMaxSourceBytes / (1024 * 1024))} MB each. Everything is
            converted to WebP for storage, which also drops the original metadata. At most{' '}
            {LIMITS.submissionMaxAttachments} screenshots per response.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function ChoiceFields({
  element,
  onChange,
}: {
  element: Extract<FormElement, { type: 'choice' }>;
  onChange: (next: FormElement) => void;
}) {
  const setOptions = (options: ChoiceOption[]) => onChange({ ...element, options });

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${element.id}-kind`}>Options</Label>
          <Select
            value={element.optionKind}
            onValueChange={(optionKind) =>
              onChange({
                ...element,
                optionKind: optionKind as 'text' | 'emoji',
                // An emoji question needs an emoji on every option, so give the
                // existing ones a starting value rather than publishing an invalid form.
                options: element.options.map((option, index) =>
                  optionKind === 'emoji' && !option.emoji
                    ? { ...option, emoji: DEFAULT_EMOJI[index % DEFAULT_EMOJI.length] }
                    : option,
                ),
              })
            }
          >
            <SelectTrigger id={`${element.id}-kind`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="text">Text</SelectItem>
              <SelectItem value="emoji">Emoji</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`${element.id}-selection`}>Selection</Label>
          <Select
            value={element.selection}
            onValueChange={(selection) =>
              onChange({ ...element, selection: selection as 'single' | 'multi' })
            }
          >
            <SelectTrigger id={`${element.id}-selection`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="single">One answer</SelectItem>
              <SelectItem value="multi">Several answers</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`${element.id}-orientation`}>Layout</Label>
          <Select
            value={element.orientation}
            onValueChange={(orientation) =>
              onChange({ ...element, orientation: orientation as 'vertical' | 'horizontal' })
            }
          >
            <SelectTrigger id={`${element.id}-orientation`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="vertical">Vertical</SelectItem>
              <SelectItem value="horizontal">Horizontal</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        <Label>Choices</Label>
        <ul className="space-y-2">
          {element.options.map((option, index) => (
            <li key={option.id} className="flex items-center gap-2">
              {element.optionKind === 'emoji' ? (
                <Input
                  value={option.emoji ?? ''}
                  className="w-16 text-center"
                  maxLength={8}
                  aria-label={`Emoji for choice ${index + 1}`}
                  onChange={(event) =>
                    setOptions(
                      element.options.map((candidate, position) =>
                        position === index
                          ? { ...candidate, emoji: event.target.value || undefined }
                          : candidate,
                      ),
                    )
                  }
                />
              ) : null}
              <Input
                value={option.label}
                maxLength={LIMITS.labelMaxLength}
                aria-label={`Label for choice ${index + 1}`}
                placeholder={`Choice ${index + 1}`}
                onChange={(event) =>
                  setOptions(
                    element.options.map((candidate, position) =>
                      position === index
                        ? { ...candidate, label: event.target.value }
                        : candidate,
                    ),
                  )
                }
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove choice ${index + 1}`}
                disabled={element.options.length <= LIMITS.choiceMinOptions}
                onClick={() =>
                  setOptions(element.options.filter((_, position) => position !== index))
                }
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>

        <Button
          variant="outline"
          size="sm"
          disabled={element.options.length >= LIMITS.choiceMaxOptions}
          onClick={() =>
            setOptions([
              ...element.options,
              {
                id: newId('option'),
                label: '',
                ...(element.optionKind === 'emoji'
                  ? { emoji: DEFAULT_EMOJI[element.options.length % DEFAULT_EMOJI.length] }
                  : {}),
              },
            ])
          }
        >
          <PlusIcon />
          Add choice
        </Button>
      </div>
    </div>
  );
}

function TextFields({
  element,
  onChange,
}: {
  element: Extract<FormElement, { type: 'text' }>;
  onChange: (next: FormElement) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${element.id}-lines`}>Input</Label>
          <Select
            value={element.multiline ? 'multi' : 'single'}
            onValueChange={(value) => onChange({ ...element, multiline: value === 'multi' })}
          >
            <SelectTrigger id={`${element.id}-lines`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="single">Single line</SelectItem>
              <SelectItem value="multi">Several lines</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`${element.id}-max`}>Character limit</Label>
          <Input
            id={`${element.id}-max`}
            type="number"
            min={1}
            max={LIMITS.textAnswerMaxLength}
            value={element.maxLength}
            onChange={(event) =>
              onChange({
                ...element,
                maxLength: clamp(Number(event.target.value) || 1, 1, LIMITS.textAnswerMaxLength),
              })
            }
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${element.id}-placeholder`}>Placeholder</Label>
        <Input
          id={`${element.id}-placeholder`}
          value={element.placeholder ?? ''}
          maxLength={LIMITS.placeholderMaxLength}
          placeholder="Start typing…"
          onChange={(event) =>
            onChange({
              ...element,
              placeholder: event.target.value === '' ? undefined : event.target.value,
            })
          }
        />
        <p className="text-xs text-muted-foreground">
          Guidance only. It is never a default answer and never satisfies a required question.
        </p>
      </div>
    </div>
  );
}

const DEFAULT_EMOJI = ['😍', '🙂', '😐', '🙁', '😡'] as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max);
}

/** A new element of the requested type, with sensible starting values. */
export function newElement(type: FormElement['type']): FormElement {
  const id = newId('element');
  switch (type) {
    case 'title':
      return { id, type: 'title', text: 'Tell us how it went' };
    case 'subtitle':
      return { id, type: 'subtitle', text: 'A short subtitle' };
    case 'body_text':
      return { id, type: 'body_text', text: 'Anything the respondent should know before answering.' };
    case 'choice':
      return {
        id,
        type: 'choice',
        label: '',
        required: true,
        optionKind: 'text',
        selection: 'single',
        orientation: 'vertical',
        options: [
          { id: newId('option'), label: '' },
          { id: newId('option'), label: '' },
        ],
      };
    case 'text':
      return {
        id,
        type: 'text',
        label: '',
        required: true,
        multiline: true,
        maxLength: 500,
        placeholder: 'Start typing…',
      };
    case 'email':
      return { id, type: 'email', label: 'Email for follow-up', required: false };
    case 'screenshot':
      return { id, type: 'screenshot', label: 'Attach a screenshot', required: false, maxCount: 3 };
  }
}

/** A copy of an element with fresh identifiers, so the copy is a distinct question. */
export function duplicateElement(element: FormElement): FormElement {
  const copy = { ...element, id: newId('element') };
  if (copy.type === 'choice') {
    copy.options = copy.options.map((option) => ({ ...option, id: newId('option') }));
  }
  return copy;
}
