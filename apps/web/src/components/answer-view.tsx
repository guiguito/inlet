import { listQuestions, type FormDefinition, type StoredAnswer } from '@inlet/shared';
import { api, type SubmissionAttachment } from '@/lib/api';
import { Badge } from '@/components/ui/badge';

/**
 * FR-065: answers are displayed using the element labels and option labels from the
 * form version the submission was made against, not from the current draft. The
 * definition travels with the submission, so a renamed question never rewrites
 * history.
 */
export function AnswerList({
  definition,
  answers,
  attachments = [],
}: {
  definition: FormDefinition;
  answers: Record<string, StoredAnswer>;
  attachments?: SubmissionAttachment[];
}) {
  const questions = listQuestions(definition);

  return (
    <dl className="divide-y">
      {questions.map((question) => {
        const answer = answers[question.id];
        return (
          <div key={question.id} className="grid gap-1 py-3 sm:grid-cols-[minmax(0,14rem)_1fr] sm:gap-6">
            <dt className="text-sm text-muted-foreground">
              {question.label}
              {question.required ? null : (
                <span className="ml-1.5 text-xs text-muted-foreground/70">optional</span>
              )}
            </dt>
            <dd className="text-sm">
              <AnswerValue
                question={question}
                answer={answer}
                attachments={attachments.filter((file) => file.questionId === question.id)}
              />
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function AnswerValue({
  question,
  answer,
  attachments,
}: {
  question: ReturnType<typeof listQuestions>[number];
  answer: StoredAnswer | undefined;
  attachments: SubmissionAttachment[];
}) {
  if (!answer) return <span className="text-muted-foreground/60">Not answered</span>;

  if (answer.type === 'choice' && question.type === 'choice') {
    return (
      <div className="flex flex-wrap gap-1.5">
        {answer.optionIds.map((optionId) => {
          const option = question.options.find((candidate) => candidate.id === optionId);
          return (
            <Badge key={optionId} variant="default">
              {option?.emoji ? <span aria-hidden="true">{option.emoji}</span> : null}
              {/* An option removed in a later version keeps its raw ID rather than vanishing. */}
              {option?.label ?? <span className="font-mono">{optionId}</span>}
            </Badge>
          );
        })}
      </div>
    );
  }

  if (answer.type === 'email') {
    return (
      <a className="text-primary underline-offset-4 hover:underline" href={`mailto:${answer.value}`}>
        {answer.value}
      </a>
    );
  }

  if (answer.type === 'text') {
    return <p className="whitespace-pre-wrap break-words">{answer.value}</p>;
  }

  if (answer.type === 'screenshot') {
    if (attachments.length === 0) {
      return <span className="text-muted-foreground/60">No screenshot</span>;
    }
    return (
      <div className="flex flex-wrap gap-2">
        {attachments.map((file) => (
          <a
            key={file.id}
            href={api.attachmentPath(file.id)}
            target="_blank"
            rel="noreferrer"
            className="group block overflow-hidden rounded-md border"
          >
            <img
              src={api.attachmentPath(file.id)}
              alt={`Screenshot ${file.id}`}
              width={file.width}
              height={file.height}
              loading="lazy"
              className="h-24 w-auto max-w-56 object-cover transition-opacity group-hover:opacity-90"
            />
          </a>
        ))}
      </div>
    );
  }

  return <span className="text-muted-foreground/60">Not answered</span>;
}

/**
 * FR-173, FR-174: a submission split into the two things a list row shows — the
 * rating it chose, and what it typed.
 *
 * Free text is what a reader is scanning for — a column of "Love it, Fine, Love it"
 * tells them nothing — so it takes the reading position and the choice becomes a chip
 * beside it. Both come from the version the submission was answered against (FR-065),
 * so a renamed question or option never rewrites history.
 */
export type AnswerSummary = {
  /** The first choice answer, as the respondent saw it. Null when the form asks none. */
  chip: { emoji: string | null; label: string } | null;
  /** The first non-empty free-text answer. Empty when the form asks none. */
  text: string;
};

export function answerSummary(
  definition: FormDefinition | undefined,
  answers: Record<string, StoredAnswer>,
): AnswerSummary {
  const questions = definition ? listQuestions(definition) : [];
  let chip: AnswerSummary['chip'] = null;
  let text = '';

  for (const question of questions) {
    const answer = answers[question.id];
    if (!answer) continue;

    if (!text && answer.type === 'text' && answer.value.trim() !== '') {
      text = answer.value;
      continue;
    }
    if (chip || answer.type !== 'choice' || question.type !== 'choice') continue;

    const optionId = answer.optionIds[0];
    if (optionId === undefined) continue;
    const option = question.options.find((candidate) => candidate.id === optionId);
    chip = {
      // An emoji only counts when the question was asked as an emoji scale, so a
      // decorated radio list does not become a chip that reads as a rating.
      emoji: question.optionKind === 'emoji' ? (option?.emoji ?? null) : null,
      // An option removed in a later version keeps its raw ID rather than vanishing.
      label: option?.label ?? optionId,
    };
  }

  // Without the version's definition there are no labels to show, so fall back to the
  // free text we hold and leave the chip off rather than inventing one.
  if (!text && !chip) {
    for (const answer of Object.values(answers)) {
      if (answer.type === 'text' && answer.value.trim() !== '') {
        text = answer.value;
        break;
      }
    }
  }

  return { chip, text };
}
