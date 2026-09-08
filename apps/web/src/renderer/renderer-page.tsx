import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { ApiError, clientApi, type ClientForm, type SubmissionIntent } from '@/lib/api';
import {
  ErrorSummary,
  FormPageView,
  PageProgress,
  toApiAnswers,
  validatePage,
  type AnswerDraft,
  type AnswerDrafts,
  type RendererPage,
} from '@/renderer/form-renderer';
import './renderer.css';

/**
 * The reference renderer as a running page.
 *
 * It is a client application, not part of the management interface: it authenticates
 * with a publishable client key and drives the four-call flow of section 9. Keeping it
 * in the repository means the client contract has a working implementation that the
 * browser tests exercise end to end.
 *
 * The key is read from the query string so an operator can open a form with one link.
 * That is correct for a publishable key, which is designed to be public; a secret
 * server key must never be used here.
 */
export function RendererPage() {
  const { databaseId = '' } = useParams();
  const [params] = useSearchParams();
  const keyFromUrl = params.get('key') ?? '';

  const [key, setKey] = useState(keyFromUrl);
  const [form, setForm] = useState<ClientForm | null>(null);
  const [intent, setIntent] = useState<SubmissionIntent | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [pageIndex, setPageIndex] = useState(0);
  const [answers, setAnswers] = useState<AnswerDrafts>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ submissionId: string; duplicate: boolean } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  /** Steps 1 and 2 of the client flow: read the form, then open an intent. */
  const start = async (withKey: string) => {
    setLoadError(null);
    try {
      const loaded = await clientApi.getForm(databaseId, withKey);
      const opened = await clientApi.createIntent(databaseId, withKey, loaded.formVersion);
      setForm(loaded);
      setIntent(opened);
      setPageIndex(0);
      setAnswers({});
      setErrors({});
      setServerErrors({});
      setResult(null);
      setSubmitError(null);
    } catch (error) {
      setLoadError(
        error instanceof ApiError ? error.message : 'This form could not be loaded.',
      );
    }
  };

  useEffect(() => {
    if (keyFromUrl) void start(keyFromUrl);
    // Starting is deliberately keyed only on the URL key: re-running on every render
    // would open a new intent each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyFromUrl, databaseId]);

  const pages = (form?.pages ?? []) as unknown as RendererPage[];
  const page = pages[pageIndex];
  const isLastPage = pageIndex === pages.length - 1;

  const setAnswer = (questionId: string, answer: AnswerDraft) => {
    setAnswers((current) => ({ ...current, [questionId]: answer }));
    setErrors((current) => {
      const { [questionId]: _removed, ...rest } = current;
      return rest;
    });
    setServerErrors((current) => {
      const { [questionId]: _removed, ...rest } = current;
      return rest;
    });
  };

  /** Step 3: uploads happen as the respondent chooses files, under the open intent. */
  const upload = async (questionId: string, file: File) => {
    if (!intent) return;
    setUploading((current) => ({ ...current, [questionId]: true }));
    try {
      const uploaded = await clientApi.uploadAttachment(
        databaseId,
        key,
        intent,
        questionId,
        file,
      );
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
      setErrors((current) => {
        const { [questionId]: _removed, ...rest } = current;
        return rest;
      });
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

  /** FR-047: removing before submission means not referencing the upload. */
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
    if (intent) {
      // Best effort: the lifecycle rule removes it anyway if this call fails.
      await clientApi.discardAttachment(databaseId, key, intent, attachmentId).catch(() => {});
    }
  };

  const goNext = () => {
    if (!page) return;
    const found = validatePage(page, answers);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setPageIndex((index) => Math.min(index + 1, pages.length - 1));
  };

  /** Step 4: one call with the whole response. */
  const submit = async () => {
    if (!form || !intent || !page) return;

    const found = validatePage(page, answers);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      const finalized = await clientApi.finalize(databaseId, key, intent, {
        formVersion: form.formVersion,
        answers: toApiAnswers(pages, answers),
        clientContext: {
          renderer: 'inlet-reference',
          userAgent: navigator.userAgent,
          language: navigator.language,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
        },
      });
      setResult({
        submissionId: finalized.submissionId,
        duplicate: finalized.status === 'duplicate',
      });
    } catch (error) {
      if (error instanceof ApiError) {
        // FR-054: the server points at the offending question, so show it there.
        const perQuestion: Record<string, string> = {};
        for (const detail of error.details) {
          if (detail.questionId) perQuestion[detail.questionId] = detail.message;
        }
        setServerErrors(perQuestion);
        setSubmitError(Object.keys(perQuestion).length > 0 ? null : error.message);

        // Jump to the first page that has a problem.
        const firstBad = pages.findIndex((candidate) =>
          candidate.elements.some((element) => perQuestion[element.id]),
        );
        if (firstBad >= 0) setPageIndex(firstBad);
      } else {
        setSubmitError('This feedback could not be submitted. Try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (!keyFromUrl && !form) {
    return (
      <RendererFrame>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void start(key);
          }}
        >
          <div className="space-y-1">
            <h1 className="text-lg font-semibold">Reference renderer</h1>
            <p className="text-sm opacity-70">
              This stands in for your client application. Paste a publishable client key to load
              the published form and run the whole flow against the API.
            </p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="key" className="block text-sm font-medium">
              Publishable client key
            </label>
            <input
              id="key"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="ipk_..."
              className="w-full rounded-[var(--r-radius)] border border-[var(--r-border)] bg-transparent px-3 py-2 font-mono text-sm outline-none focus-visible:border-[var(--r-accent)]"
            />
          </div>
          {loadError ? (
            <p role="alert" className="text-sm text-[var(--r-danger)]">
              {loadError}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={key.trim() === ''}
            className="w-full rounded-[var(--r-radius)] bg-[var(--r-accent)] px-4 py-2 text-sm font-medium text-[var(--r-accent-contrast)] disabled:opacity-50"
          >
            Load the form
          </button>
        </form>
      </RendererFrame>
    );
  }

  if (loadError) {
    return (
      <RendererFrame>
        <div className="space-y-3">
          <h1 className="text-lg font-semibold">This form is not available</h1>
          <p role="alert" className="text-sm text-[var(--r-danger)]">
            {loadError}
          </p>
        </div>
      </RendererFrame>
    );
  }

  if (result) {
    return (
      <RendererFrame>
        <div className="space-y-3" data-testid="renderer-done">
          <h1 className="text-lg font-semibold">Thank you</h1>
          <p className="text-sm opacity-80">
            {result.duplicate
              ? 'This response had already been received, so nothing was duplicated.'
              : 'Your feedback has been recorded.'}
          </p>
          <p className="font-mono text-xs opacity-60" data-testid="submission-id">
            {result.submissionId}
          </p>
        </div>
      </RendererFrame>
    );
  }

  if (!form || !page) {
    return (
      <RendererFrame>
        <p className="text-sm opacity-70">Loading the form</p>
      </RendererFrame>
    );
  }

  return (
    <RendererFrame>
      <form
        className="space-y-6"
        // Validation is this component's job, so every message is consistent and the
        // error summary always appears.
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (isLastPage) void submit();
          else goNext();
        }}
      >
        {pages.length > 1 ? <PageProgress current={pageIndex} total={pages.length} /> : null}

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

        <div className="flex items-center justify-between gap-3 border-t border-[var(--r-border)] pt-4">
          <button
            type="button"
            disabled={pageIndex === 0}
            onClick={() => setPageIndex((index) => Math.max(0, index - 1))}
            className="rounded-[var(--r-radius)] border border-[var(--r-border)] px-4 py-2 text-sm disabled:opacity-40"
          >
            Back
          </button>

          <button
            type="submit"
            disabled={submitting}
            data-testid={isLastPage ? 'renderer-submit' : 'renderer-next'}
            className="rounded-[var(--r-radius)] bg-[var(--r-accent)] px-5 py-2 text-sm font-medium text-[var(--r-accent-contrast)] disabled:opacity-50"
          >
            {isLastPage ? (submitting ? 'Submitting' : 'Submit') : 'Next'}
          </button>
        </div>
      </form>
    </RendererFrame>
  );
}

/**
 * The renderer's own shell. It sets only its own variables, so a host application can
 * override them and the form takes on the host's look with no code change.
 */
function RendererFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="inlet-renderer min-h-dvh px-4 py-10">
      <div className="mx-auto w-full max-w-xl rounded-[var(--r-radius)] border border-[var(--r-border)] bg-[var(--r-surface)] p-6 sm:p-8">
        {children}
      </div>
    </div>
  );
}
