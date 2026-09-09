import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { brandingVariables, resolveDark } from '@inlet/shared';
import { ApiError, hostedApi, type HostedFormPublic, type SubmissionIntent } from '@/lib/api';
import {
  ErrorSummary,
  FormPageView,
  PageProgress,
  toApiAnswers,
  validatePage,
  type AnswerDraft,
  type AnswerDrafts,
  type RendererElement,
  type RendererPage,
} from '@/renderer/form-renderer';
import './hosted.css';

/**
 * The hosted form (FR-130 to FR-153).
 *
 * One link an operator shares. It is a second way to collect, beside the client API,
 * and it runs the same four-call flow against the same services: the only difference
 * is that a slug in the path authorizes it instead of a project key.
 *
 * Nothing here touches a cookie or browser storage (FR-136), so it works inside a
 * third-party frame, inside a webview, and with site data blocked. Nothing here shows
 * Inlet's own name to a respondent (FR-144): the page belongs to the operator.
 */

export function HostedFormPage() {
  const { slug = '' } = useParams();
  const [params] = useSearchParams();

  const source = params.get('source');
  const embedded = params.get('embed') === '1';

  const [config, setConfig] = useState<HostedFormPublic | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [pageIndex, setPageIndex] = useState(0);
  const [answers, setAnswers] = useState<AnswerDrafts>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  /**
   * The intent is opened on first need rather than on load, so a page view that never
   * becomes a response leaves nothing behind. A public link gets opened by crawlers,
   * link previews and people who change their mind.
   */
  const intentRef = useRef<SubmissionIntent | null>(null);
  const openIntent = async (): Promise<SubmissionIntent> => {
    if (intentRef.current) return intentRef.current;
    const opened = await hostedApi.createIntent(slug);
    intentRef.current = opened;
    return opened;
  };

  useEffect(() => {
    const controller = new AbortController();
    setConfig(null);
    setLoadError(null);
    hostedApi
      .getForm(slug, controller.signal)
      .then(setConfig)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(
          error instanceof ApiError ? error.message : 'This form could not be loaded.',
        );
      });
    return () => controller.abort();
  }, [slug]);

  const pages = (config?.form?.pages ?? []) as unknown as RendererPage[];

  /** Prefilled answers are ordinary answers: editable, validated, stored the same. */
  useEffect(() => {
    if (pages.length === 0) return;
    setAnswers((current) => (Object.keys(current).length > 0 ? current : prefill(pages, params)));
    // Only the loaded form matters here; a later query change should not wipe typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  /** FR-153: the embedding page learns the height it needs without measuring us. */
  useEffect(() => {
    if (!embedded || window.parent === window) return;
    const post = () => {
      const height = Math.ceil(document.documentElement.scrollHeight);
      // The height is not sensitive and the embedding origin is unknown by design,
      // since a form may be allowed to embed anywhere.
      window.parent.postMessage({ source: 'inlet', type: 'height', slug, height }, '*');
    };
    post();
    const observer = new ResizeObserver(post);
    observer.observe(document.documentElement);
    return () => observer.disconnect();
  }, [embedded, slug, pageIndex, done, config]);

  const dark = usePrefersDark(config?.branding.colorScheme ?? 'system');
  const variables = useMemo(
    () => (config ? brandingVariables(config.branding, dark) : null),
    [config, dark],
  );

  /**
   * The branding goes on the document root, not on a wrapper: the background then
   * reaches the edges of the page and of an iframe of any height, and it lands on the
   * same variables the server injected into the initial HTML, so the loaded
   * configuration replaces the injected one with no flash between them.
   */
  useEffect(() => {
    if (!variables) return;
    const root = document.documentElement;
    for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value);
  }, [variables]);

  const page = pages[pageIndex];
  const isLastPage = pageIndex === pages.length - 1;

  const setAnswer = (questionId: string, answer: AnswerDraft) => {
    setAnswers((current) => ({ ...current, [questionId]: answer }));
    setErrors((current) => without(current, questionId));
    setServerErrors((current) => without(current, questionId));
  };

  const upload = async (questionId: string, file: File) => {
    setUploading((current) => ({ ...current, [questionId]: true }));
    try {
      const intent = await openIntent();
      const uploaded = await hostedApi.uploadAttachment(slug, intent, questionId, file);
      setAnswers((current) => {
        const existing = current[questionId];
        const files = existing?.kind === 'screenshot' ? existing.files : [];
        return {
          ...current,
          [questionId]: {
            kind: 'screenshot',
            files: [
              ...files,
              {
                attachmentId: uploaded.attachmentId,
                name: file.name,
                previewUrl: URL.createObjectURL(file),
              },
            ],
          },
        };
      });
      setErrors((current) => without(current, questionId));
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [questionId]:
          error instanceof ApiError ? error.message : 'That screenshot could not be uploaded.',
      }));
    } finally {
      setUploading((current) => ({ ...current, [questionId]: false }));
    }
  };

  const removeFile = async (questionId: string, attachmentId: string) => {
    setAnswers((current) => {
      const existing = current[questionId];
      if (existing?.kind !== 'screenshot') return current;
      return {
        ...current,
        [questionId]: {
          kind: 'screenshot',
          files: existing.files.filter((file) => file.attachmentId !== attachmentId),
        },
      };
    });
    const intent = intentRef.current;
    if (intent) {
      // Best effort: an unreferenced upload expires on its own.
      await hostedApi.discardAttachment(slug, intent, attachmentId).catch(() => {});
    }
  };

  const submit = async () => {
    if (!config?.form || !page) return;

    const found = validatePage(page, answers);
    setErrors(found);
    // The error summary takes focus itself, which is the accessible behaviour.
    if (Object.keys(found).length > 0) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      const intent = await openIntent();
      await hostedApi.submit(slug, intent, {
        formVersion: config.form.formVersion,
        answers: toApiAnswers(pages, answers),
        context: {
          ...(source ? { source } : {}),
          userAgent: navigator.userAgent,
          language: navigator.language,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
          ...(embedded && document.referrer ? { embeddedOn: document.referrer } : {}),
        },
      });

      // FR-141: a redirect replaces the page, so the respondent lands where the
      // operator wants them without a stop on a thank-you they did not ask for.
      const redirect = config.behaviour.redirectUrl;
      if (redirect) {
        window.location.replace(redirect);
        return;
      }
      setDone(true);
      window.scrollTo({ top: 0 });
    } catch (error) {
      if (error instanceof ApiError) {
        const perQuestion: Record<string, string> = {};
        for (const detail of error.details) {
          if (detail.questionId) perQuestion[detail.questionId] = detail.message;
        }
        setServerErrors(perQuestion);
        setSubmitError(Object.keys(perQuestion).length > 0 ? null : error.message);

        const firstBad = pages.findIndex((candidate) =>
          candidate.elements.some((element) => perQuestion[element.id]),
        );
        if (firstBad >= 0) setPageIndex(firstBad);

        // An expired or already-used intent must not strand the respondent on a
        // button that will keep failing: the next attempt opens a fresh one.
        if (error.code === 'intent_expired' || error.code === 'intent_not_found') {
          intentRef.current = null;
        }
      } else {
        setSubmitError('This feedback could not be sent. Try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const frame = (children: React.ReactNode, testId?: string) => (
    <HostedFrame embedded={embedded} testId={testId}>
      {config?.branding.logoUrl ? (
        <img
          src={config.branding.logoUrl}
          alt={config.branding.logoAlt ?? ''}
          width={config.branding.logoWidth ?? undefined}
          height={config.branding.logoHeight ?? undefined}
          className="mb-6 block h-10 w-auto max-w-[60%] object-contain"
        />
      ) : null}
      {children}
    </HostedFrame>
  );

  if (loadError) {
    return frame(
      <div className="space-y-2" data-testid="hosted-unavailable">
        <h1 className="text-lg font-semibold">This form is not available</h1>
        <p role="alert" className="text-sm opacity-80">
          {loadError}
        </p>
      </div>,
    );
  }

  if (!config) {
    return (
      <HostedFrame embedded={embedded}>
        <p className="text-sm opacity-70">Loading</p>
      </HostedFrame>
    );
  }

  // FR-142: a closed form shows the operator's message. The API sends no questions
  // with it, so there is nothing here that could leak.
  if (!config.open || !config.form || pages.length === 0) {
    return frame(
      <p className="text-sm" data-testid="hosted-closed">
        {config.closedMessage}
      </p>,
    );
  }

  if (done) {
    return frame(
      <div className="space-y-2">
        <h1 className="text-lg font-semibold">{config.copy.thankYouTitle}</h1>
        {config.copy.thankYouBody ? (
          <p className="text-sm opacity-80">{config.copy.thankYouBody}</p>
        ) : null}
      </div>,
      'hosted-done',
    );
  }

  if (!page) return null;

  return frame(
    <form
      className="space-y-6"
      // This component owns validation, so every message reads the same and the
      // error summary always appears (FR-052).
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (isLastPage) {
          void submit();
          return;
        }
        const found = validatePage(page, answers);
        setErrors(found);
        if (Object.keys(found).length > 0) return;
        setPageIndex((index) => Math.min(index + 1, pages.length - 1));
        window.scrollTo({ top: 0 });
      }}
    >
      {config.behaviour.showProgress && pages.length > 1 ? (
        <PageProgress current={pageIndex} total={pages.length} />
      ) : null}

      <ErrorSummary page={page} errors={{ ...serverErrors, ...errors }} />

      <FormPageView
        page={page}
        answers={answers}
        errors={errors}
        serverErrors={serverErrors}
        uploading={uploading}
        onAnswer={setAnswer}
        onUpload={(questionId, file) => void upload(questionId, file)}
        onRemoveFile={(questionId, attachmentId) => void removeFile(questionId, attachmentId)}
      />

      {submitError ? (
        <p role="alert" className="text-sm text-[var(--r-danger)]">
          {submitError}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--r-border)] pt-4">
        {pages.length > 1 ? (
          <button
            type="button"
            disabled={pageIndex === 0 || submitting}
            onClick={() => setPageIndex((index) => Math.max(0, index - 1))}
            // 44px minimum target, for a form that is mostly used on a phone (FR-137).
            className="min-h-11 rounded-[var(--r-radius)] border border-[var(--r-border)] px-4 text-sm disabled:opacity-40"
          >
            Back
          </button>
        ) : (
          <span />
        )}

        <button
          type="submit"
          disabled={submitting}
          data-testid={isLastPage ? 'hosted-submit' : 'hosted-next'}
          className="min-h-11 flex-1 rounded-[var(--r-radius)] bg-[var(--r-accent)] px-5 text-sm font-medium text-[var(--r-accent-contrast)] disabled:opacity-60 sm:flex-none"
        >
          {isLastPage ? (submitting ? 'Sending' : config.copy.submitLabel) : 'Next'}
        </button>
      </div>
    </form>,
  );
}

/**
 * The page's shell.
 *
 * Embedded, the card is dropped: the embedding page already provides the surround, and
 * a card inside a card looks like a mistake. Standalone, the form sits on a centred
 * card with the branded background behind it.
 */
function HostedFrame({
  children,
  embedded,
  testId,
}: {
  children: React.ReactNode;
  embedded: boolean;
  testId?: string;
}) {
  return (
    <div
      className={embedded ? 'px-4 py-4' : 'min-h-dvh px-4 py-8 sm:py-12'}
      data-testid={testId}
    >
      <div
        className={
          embedded
            ? 'mx-auto w-full max-w-xl'
            : 'mx-auto w-full max-w-xl rounded-[var(--r-radius)] border border-[var(--r-border)] bg-[var(--r-surface)] p-5 sm:p-8'
        }
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Tracks the device preference, but only when the operator asked to follow it. The
 * server injected the same decision into the initial HTML, so this only has to keep up
 * with a viewer who changes the setting while the form is open.
 */
function usePrefersDark(scheme: 'light' | 'dark' | 'system'): boolean {
  const query = '(prefers-color-scheme: dark)';
  const [prefersDark, setPrefersDark] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );

  useEffect(() => {
    if (scheme !== 'system') return;
    const media = window.matchMedia(query);
    const listener = () => setPrefersDark(media.matches);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, [scheme]);

  return resolveDark(scheme, prefersDark);
}

/**
 * FR-147: query parameters prefill answers, so a link in an email can carry a first
 * answer. A choice may name an option by its ID or by its label, because a
 * hand-written link is far more likely to say "yes" than "op_7k2...".
 */
function prefill(pages: RendererPage[], params: URLSearchParams): AnswerDrafts {
  const drafts: AnswerDrafts = {};

  for (const page of pages) {
    for (const element of page.elements as RendererElement[]) {
      // The parameter is named by the question's own ID, which is what the builder
      // shows and what an operator pastes into a link.
      const values = params.getAll(element.id).filter((value) => value.trim() !== '');
      if (values.length === 0) continue;

      if (element.type === 'text' || element.type === 'email') {
        const [value] = values;
        if (value !== undefined) drafts[element.id] = { kind: 'text', value };
        continue;
      }

      if (element.type === 'choice') {
        const options = element.options ?? [];
        const matched = values
          .map((value) => {
            const wanted = value.trim().toLowerCase();
            return options.find(
              (option) =>
                option.id.toLowerCase() === wanted || option.label.toLowerCase() === wanted,
            )?.id;
          })
          .filter((id): id is string => id !== undefined);
        if (matched.length === 0) continue;
        drafts[element.id] = {
          kind: 'choice',
          optionIds: element.selection === 'single' ? matched.slice(0, 1) : [...new Set(matched)],
        };
      }
      // A screenshot cannot be prefilled from a link, so it is left alone.
    }
  }

  return drafts;
}

function without(
  record: Record<string, string>,
  key: string,
): Record<string, string> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}
