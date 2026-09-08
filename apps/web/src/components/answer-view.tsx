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
 * A one-line preview of a submission for the list view.
 *
 * Free text first, whatever its position in the form: a column of "Love it, Fine,
 * Love it" tells a reader nothing, while the comments are what they are scanning for.
 * Choices are the fallback for a form that asks no open question.
 */
export function answerPreview(
  definition: FormDefinition | undefined,
  answers: Record<string, StoredAnswer>,
): string {
  const questions = definition ? listQuestions(definition) : [];

  for (const question of questions) {
    const answer = answers[question.id];
    if (answer?.type === 'text' && answer.value.trim() !== '') return answer.value;
  }

  for (const question of questions) {
    const answer = answers[question.id];
    if (answer?.type !== 'choice' || question.type !== 'choice') continue;
    const labels = answer.optionIds.map((id) => {
      const option = question.options.find((candidate) => candidate.id === id);
      if (!option) return id;
      return question.optionKind === 'emoji' && option.emoji
        ? `${option.emoji} ${option.label}`
        : option.label;
    });
    if (labels.length > 0) return labels.join(', ');
  }

  // Without the version's definition, fall back to any free-text value we hold.
  for (const answer of Object.values(answers)) {
    if (answer.type === 'text' && answer.value.trim() !== '') return answer.value;
  }
  return '';
}
