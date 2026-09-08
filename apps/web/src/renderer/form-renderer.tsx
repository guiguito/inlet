import { useMemo, useRef, useState } from 'react';
import { LIMITS } from '@inlet/shared';
import { cn } from '@/lib/utils';

/**
 * The reference form renderer.
 *
 * PRD section 20.5: the respondent-facing form is rendered by the client application,
 * so this ships unbranded and themeable. It carries no Inlet mark, no accent colour
 * and no product copy; every colour comes from CSS custom properties a host can
 * override.
 *
 * It also demonstrates the client contract: page navigation and per-page validation
 * are entirely the client's business (FR-050), and the whole response goes to the
 * server in one final call (FR-051).
 *
 * Accessibility (section 12.5): real fieldsets and legends, labels tied to inputs,
 * validation messages associated through aria-describedby, and an error summary that
 * takes focus.
 */

export type RendererElement = {
  id: string;
  type: 'title' | 'subtitle' | 'body_text' | 'choice' | 'text' | 'email' | 'screenshot';
  text?: string;
  label?: string;
  helperText?: string;
  required?: boolean;
  optionKind?: 'text' | 'emoji';
  selection?: 'single' | 'multi';
  orientation?: 'vertical' | 'horizontal';
  options?: { id: string; label: string; emoji?: string }[];
  multiline?: boolean;
  maxLength?: number;
  placeholder?: string;
  maxCount?: number;
  acceptedMediaTypes?: string[];
  maxFileBytes?: number;
};

export type RendererPage = { id: string; elements: RendererElement[] };

/** What the respondent has entered so far, before it becomes an API payload. */
export type AnswerDraft =
  | { kind: 'choice'; optionIds: string[] }
  | { kind: 'text'; value: string }
  | { kind: 'screenshot'; files: { attachmentId: string; name: string; previewUrl: string }[] };

export type AnswerDrafts = Record<string, AnswerDraft>;

const QUESTION_TYPES = new Set(['choice', 'text', 'email', 'screenshot']);

export function isRendererQuestion(element: RendererElement): boolean {
  return QUESTION_TYPES.has(element.type);
}

/** FR-052: the client validates before it advances, and again before it submits. */
export function validatePage(
  page: RendererPage,
  answers: AnswerDrafts,
): Record<string, string> {
  const errors: Record<string, string> = {};

  for (const element of page.elements) {
    if (!isRendererQuestion(element)) continue;
    const answer = answers[element.id];

    if (element.type === 'choice') {
      const chosen = answer?.kind === 'choice' ? answer.optionIds : [];
      if (element.required && chosen.length === 0) errors[element.id] = 'Choose an answer.';
      continue;
    }

    if (element.type === 'text' || element.type === 'email') {
      const value = answer?.kind === 'text' ? answer.value.trim() : '';
      if (value === '') {
        if (element.required) errors[element.id] = 'This question needs an answer.';
        continue;
      }
      if (element.maxLength && value.length > element.maxLength) {
        errors[element.id] = `Use at most ${element.maxLength} characters.`;
        continue;
      }
      if (element.type === 'email' && !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value)) {
        errors[element.id] = 'Enter a valid email address.';
      }
      continue;
    }

    if (element.type === 'screenshot') {
      const files = answer?.kind === 'screenshot' ? answer.files : [];
      if (element.required && files.length === 0) {
        errors[element.id] = 'Attach at least one screenshot.';
      }
    }
  }

  return errors;
}

/** Turns the local draft into the answers the API expects (FR-093). */
export function toApiAnswers(
  pages: RendererPage[],
  answers: AnswerDrafts,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  for (const page of pages) {
    for (const element of page.elements) {
      const answer = answers[element.id];
      if (!answer) continue;

      if (element.type === 'choice' && answer.kind === 'choice') {
        if (answer.optionIds.length === 0) continue;
        payload[element.id] =
          element.selection === 'single'
            ? { optionId: answer.optionIds[0] }
            : { optionIds: answer.optionIds };
      } else if (
        (element.type === 'text' || element.type === 'email') &&
        answer.kind === 'text'
      ) {
        if (answer.value.trim() === '') continue;
        payload[element.id] = { value: answer.value };
      } else if (element.type === 'screenshot' && answer.kind === 'screenshot') {
        if (answer.files.length === 0) continue;
        payload[element.id] = { attachmentIds: answer.files.map((file) => file.attachmentId) };
      }
    }
  }

  return payload;
}

export function FormPageView({
  page,
  answers,
  errors,
  serverErrors,
  uploading,
  onAnswer,
  onUpload,
  onRemoveFile,
}: {
  page: RendererPage;
  answers: AnswerDrafts;
  errors: Record<string, string>;
  serverErrors: Record<string, string>;
  uploading: Record<string, boolean>;
  onAnswer: (questionId: string, answer: AnswerDraft) => void;
  onUpload: (questionId: string, file: File) => void;
  onRemoveFile: (questionId: string, attachmentId: string) => void;
}) {
  return (
    <div className="space-y-7">
      {page.elements.map((element) => (
        <ElementView
          key={element.id}
          element={element}
          answer={answers[element.id]}
          error={errors[element.id] ?? serverErrors[element.id]}
          uploading={uploading[element.id] ?? false}
          onAnswer={(answer) => onAnswer(element.id, answer)}
          onUpload={(file) => onUpload(element.id, file)}
          onRemoveFile={(attachmentId) => onRemoveFile(element.id, attachmentId)}
        />
      ))}
    </div>
  );
}

function ElementView({
  element,
  answer,
  error,
  uploading,
  onAnswer,
  onUpload,
  onRemoveFile,
}: {
  element: RendererElement;
  answer: AnswerDraft | undefined;
  error: string | undefined;
  uploading: boolean;
  onAnswer: (answer: AnswerDraft) => void;
  onUpload: (file: File) => void;
  onRemoveFile: (attachmentId: string) => void;
}) {
  const errorId = `${element.id}-error`;
  const helperId = `${element.id}-helper`;
  const described = [element.helperText ? helperId : null, error ? errorId : null]
    .filter(Boolean)
    .join(' ');

  if (element.type === 'title') {
    return <h2 className="text-xl font-semibold tracking-tight">{element.text}</h2>;
  }
  if (element.type === 'subtitle') {
    return <h3 className="text-base font-medium">{element.text}</h3>;
  }
  if (element.type === 'body_text') {
    return <p className="whitespace-pre-wrap text-sm opacity-80">{element.text}</p>;
  }

  // The separators matter: without them a screen reader reads the label and the
  // marker as one run-on word.
  const legend = (
    <>
      <span className="text-sm font-medium">{element.label}</span>
      {element.required ? (
        <span aria-hidden="true" className="ml-1 opacity-60">
          *
        </span>
      ) : (
        <span className="ml-2 text-xs opacity-60"> (optional)</span>
      )}
    </>
  );

  const helper = element.helperText ? (
    <p id={helperId} className="text-xs opacity-70">
      {element.helperText}
    </p>
  ) : null;

  const errorNode = error ? (
    <p id={errorId} role="alert" className="text-xs text-[var(--r-danger)]">
      {error}
    </p>
  ) : null;

  if (element.type === 'choice') {
    const chosen = answer?.kind === 'choice' ? answer.optionIds : [];
    const multiple = element.selection === 'multi';

    return (
      <fieldset
        aria-invalid={error ? true : undefined}
        aria-describedby={described || undefined}
        className="space-y-2"
      >
        <legend className="mb-1">{legend}</legend>
        {helper}
        <div
          className={cn(
            'gap-2',
            element.orientation === 'horizontal' ? 'flex flex-wrap' : 'grid',
          )}
        >
          {(element.options ?? []).map((option) => {
            const selected = chosen.includes(option.id);
            return (
              <label
                key={option.id}
                className={cn(
                  'flex cursor-pointer items-center gap-2.5 rounded-[var(--r-radius)] border px-3 py-2 text-sm transition-colors',
                  selected
                    ? 'border-[var(--r-selected-border)] bg-[var(--r-selected-bg)]'
                    : 'border-[var(--r-border)] hover:bg-[var(--r-hover)]',
                )}
              >
                <input
                  type={multiple ? 'checkbox' : 'radio'}
                  name={element.id}
                  value={option.id}
                  checked={selected}
                  className="size-4 accent-[var(--r-accent)]"
                  onChange={(event) => {
                    if (multiple) {
                      onAnswer({
                        kind: 'choice',
                        optionIds: event.target.checked
                          ? [...chosen, option.id]
                          : chosen.filter((id) => id !== option.id),
                      });
                    } else {
                      onAnswer({ kind: 'choice', optionIds: [option.id] });
                    }
                  }}
                />
                {element.optionKind === 'emoji' && option.emoji ? (
                  <span aria-hidden="true" className="text-lg leading-none">
                    {option.emoji}
                  </span>
                ) : null}
                <span>{option.label}</span>
              </label>
            );
          })}
        </div>
        {errorNode}
      </fieldset>
    );
  }

  if (element.type === 'text' || element.type === 'email') {
    const value = answer?.kind === 'text' ? answer.value : '';
    const shared = {
      id: element.id,
      value,
      // FR-040A: the placeholder is guidance, never a value.
      placeholder: element.placeholder,
      maxLength: element.maxLength,
      'aria-invalid': error ? true : undefined,
      'aria-describedby': described || undefined,
      // aria-required, not the HTML attribute: a native `required` makes the browser
      // block the submit event, so this component's own validation never runs and the
      // respondent gets a browser bubble instead of the error summary.
      'aria-required': element.required || undefined,
      className:
        'w-full rounded-[var(--r-radius)] border border-[var(--r-border)] bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-[var(--r-accent)]',
      onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        onAnswer({ kind: 'text', value: event.target.value }),
    };

    return (
      <div className="space-y-2">
        <label htmlFor={element.id} className="block">
          {legend}
        </label>
        {helper}
        {element.type === 'email' ? (
          <input {...shared} type="email" inputMode="email" autoComplete="email" />
        ) : element.multiline ? (
          <textarea {...shared} rows={4} />
        ) : (
          <input {...shared} type="text" />
        )}
        <div className="flex items-center justify-between gap-2">
          {errorNode ?? <span />}
          {element.maxLength ? (
            <span className="text-xs opacity-60 tabular-nums">
              {value.length}/{element.maxLength}
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  // Screenshot upload (FR-043 to FR-047).
  const files = answer?.kind === 'screenshot' ? answer.files : [];
  const maxCount = element.maxCount ?? 1;
  const maxBytes = element.maxFileBytes ?? LIMITS.attachmentMaxSourceBytes;

  return (
    <div className="space-y-2">
      <label htmlFor={element.id} className="block">
        {legend}
      </label>
      {helper}

      <ScreenshotPicker
        id={element.id}
        accept={(element.acceptedMediaTypes ?? []).join(',')}
        disabled={uploading || files.length >= maxCount}
        uploading={uploading}
        describedBy={described || undefined}
        onSelect={onUpload}
      />

      <p className="text-xs opacity-70">
        {(element.acceptedMediaTypes ?? [])
          .map((type) => type.replace('image/', '').toUpperCase())
          .join(', ')}
        {' up to '}
        {Math.floor(maxBytes / (1024 * 1024))} MB each, {maxCount} maximum. Please avoid
        including sensitive personal data in screenshots.
      </p>

      {files.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {files.map((file) => (
            <li
              key={file.attachmentId}
              className="flex items-center gap-2 rounded-[var(--r-radius)] border border-[var(--r-border)] p-1.5"
            >
              <img
                src={file.previewUrl}
                alt=""
                className="size-12 rounded-[calc(var(--r-radius)-2px)] object-cover"
              />
              <span className="max-w-40 truncate text-xs">{file.name}</span>
              <button
                type="button"
                className="rounded px-1.5 py-0.5 text-xs opacity-70 hover:opacity-100"
                onClick={() => onRemoveFile(file.attachmentId)}
                aria-label={`Remove ${file.name}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {errorNode}
    </div>
  );
}

function ScreenshotPicker({
  id,
  accept,
  disabled,
  uploading,
  describedBy,
  onSelect,
}: {
  id: string;
  accept: string;
  disabled: boolean;
  uploading: boolean;
  describedBy: string | undefined;
  onSelect: (file: File) => void;
}) {
  const input = useRef<HTMLInputElement | null>(null);

  return (
    <>
      <input
        ref={input}
        id={id}
        type="file"
        accept={accept}
        className="sr-only"
        aria-describedby={describedBy}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onSelect(file);
          // Reset so the same file can be chosen again after a removal.
          event.target.value = '';
        }}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => input.current?.click()}
        className="rounded-[var(--r-radius)] border border-dashed border-[var(--r-border)] px-4 py-3 text-sm transition-colors hover:bg-[var(--r-hover)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {uploading ? 'Uploading' : 'Choose a screenshot'}
      </button>
    </>
  );
}

/** An error summary that takes focus, so a keyboard user is told what to fix. */
export function ErrorSummary({
  page,
  errors,
}: {
  page: RendererPage;
  errors: Record<string, string>;
}) {
  const heading = useRef<HTMLParagraphElement | null>(null);
  const entries = useMemo(
    () =>
      page.elements
        .filter((element) => errors[element.id])
        .map((element) => ({
          id: element.id,
          label: element.label ?? element.id,
          message: errors[element.id] ?? '',
        })),
    [page, errors],
  );

  if (entries.length === 0) return null;

  return (
    <div
      role="alert"
      tabIndex={-1}
      ref={(node) => {
        heading.current = node;
        node?.focus();
      }}
      className="rounded-[var(--r-radius)] border border-[var(--r-danger)] p-3 text-sm"
    >
      <p className="font-medium">Some answers need attention</p>
      <ul className="mt-1 space-y-0.5">
        {entries.map((entry) => (
          <li key={entry.id}>
            <a href={`#${entry.id}`} className="underline underline-offset-2">
              {entry.label}
            </a>
            : {entry.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Progress across pages, announced to assistive technology. */
export function PageProgress({ current, total }: { current: number; total: number }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs opacity-70" aria-live="polite">
        Page {current + 1} of {total}
      </p>
      <div
        role="progressbar"
        aria-valuemin={1}
        aria-valuemax={total}
        aria-valuenow={current + 1}
        className="h-1 w-full overflow-hidden rounded-full bg-[var(--r-border)]"
      >
        <div
          className="h-full bg-[var(--r-accent)] transition-[width]"
          style={{ width: `${((current + 1) / total) * 100}%` }}
        />
      </div>
    </div>
  );
}
