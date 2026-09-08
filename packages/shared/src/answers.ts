import { z } from 'zod';
import type { ErrorDetail } from './errors.js';
import { questionsById, type FormDefinition, type QuestionElement } from './form.js';
import { LIMITS } from './limits.js';

/**
 * FR-093: answers are identified by stable question ID. The shape of each answer is
 * determined by the question's type in the pinned form version, so the client does
 * not repeat the type. Exactly one of the four shapes is accepted per answer.
 */
export const answerInputSchema = z.union([
  z.object({ optionId: z.string() }).strict(),
  z.object({ optionIds: z.array(z.string()).max(LIMITS.choiceMaxOptions) }).strict(),
  z.object({ value: z.string() }).strict(),
  z.object({ attachmentIds: z.array(z.string()).max(LIMITS.submissionMaxAttachments) }).strict(),
]);

export const answersInputSchema = z.record(z.string(), answerInputSchema);

export type AnswerInput = z.infer<typeof answerInputSchema>;
export type AnswersInput = z.infer<typeof answersInputSchema>;

/** The normalized, stored answer shapes. One per question type. */
export type StoredAnswer =
  | { type: 'choice'; optionIds: string[] }
  | { type: 'text'; value: string }
  | { type: 'email'; value: string }
  | { type: 'screenshot'; attachmentIds: string[] };

export type StoredAnswers = Record<string, StoredAnswer>;

/**
 * Email syntax validation (FR-048, FR-093).
 *
 * Deliberately a pragmatic single-@ check with a dotted domain rather than a full
 * RFC 5322 grammar: the goal is to catch typos in a feedback form, and stricter
 * patterns reject addresses that real mail servers accept.
 */
const EMAIL_PATTERN = /^[^\s@,;:<>"()[\]\\]+@[^\s@.,;:<>"()[\]\\]+(\.[^\s@.,;:<>"()[\]\\]+)+$/;
export const EMAIL_MAX_LENGTH = 254;

export function isValidEmail(value: string): boolean {
  return value.length <= EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(value);
}

export type ValidateAnswersResult =
  | { ok: true; answers: StoredAnswers; attachmentIds: string[] }
  | { ok: false; details: ErrorDetail[] };

/**
 * Validates a submission payload against a pinned form version (FR-052 to FR-054).
 *
 * Returns question-level details on failure so the client can point at the offending
 * question. Attachment *ownership* is not checked here: it needs the intent and is
 * verified by the API before the submission is stored (FR-099).
 */
export function validateAnswers(
  definition: FormDefinition,
  input: AnswersInput,
): ValidateAnswersResult {
  const questions = questionsById(definition);
  const details: ErrorDetail[] = [];
  const answers: StoredAnswers = {};
  const attachmentIds: string[] = [];

  for (const questionId of Object.keys(input)) {
    if (!questions.has(questionId)) {
      details.push({
        questionId,
        code: 'unknown_question',
        message: `This form version has no question ${questionId}.`,
      });
    }
  }

  for (const question of questions.values()) {
    const raw = input[question.id];
    const answer = normalizeAnswer(question, raw, details);
    if (answer) {
      answers[question.id] = answer;
      if (answer.type === 'screenshot') attachmentIds.push(...answer.attachmentIds);
    }
  }

  if (attachmentIds.length > LIMITS.submissionMaxAttachments) {
    details.push({
      code: 'too_many_attachments',
      message: `A submission may reference at most ${LIMITS.submissionMaxAttachments} screenshots.`,
    });
  }

  const duplicates = attachmentIds.filter((id, index) => attachmentIds.indexOf(id) !== index);
  if (duplicates.length > 0) {
    details.push({
      code: 'attachment_reference_invalid',
      message: `Screenshot ${duplicates[0]} is referenced more than once.`,
    });
  }

  if (details.length > 0) return { ok: false, details };
  return { ok: true, answers, attachmentIds };
}

/**
 * Validates one answer and returns its stored form, or undefined when the question
 * is legitimately unanswered (FR-053) or the answer is invalid.
 */
function normalizeAnswer(
  question: QuestionElement,
  raw: AnswerInput | undefined,
  details: ErrorDetail[],
): StoredAnswer | undefined {
  const required = (): void => {
    if (question.required) {
      details.push({
        questionId: question.id,
        code: 'missing_required_answer',
        message: `"${question.label}" needs an answer.`,
      });
    }
  };

  const invalid = (code: string, message: string): undefined => {
    details.push({ questionId: question.id, code, message });
    return undefined;
  };

  if (raw === undefined) {
    required();
    return undefined;
  }

  switch (question.type) {
    case 'choice': {
      const optionIds = readOptionIds(raw);
      if (optionIds === null) {
        return invalid(
          'invalid_answer',
          `"${question.label}" expects ${question.selection === 'single' ? 'an optionId' : 'an optionIds array'}.`,
        );
      }
      if (optionIds.length === 0) {
        required();
        return undefined;
      }
      if (question.selection === 'single' && optionIds.length > 1) {
        return invalid('invalid_answer', `"${question.label}" accepts one option only.`);
      }
      const known = new Set(question.options.map((option) => option.id));
      const unknown = optionIds.find((id) => !known.has(id));
      if (unknown !== undefined) {
        return invalid('invalid_option', `"${question.label}" has no option ${unknown}.`);
      }
      if (new Set(optionIds).size !== optionIds.length) {
        return invalid('invalid_answer', `"${question.label}" lists the same option twice.`);
      }
      return { type: 'choice', optionIds };
    }

    case 'text': {
      if (!('value' in raw)) {
        return invalid('invalid_answer', `"${question.label}" expects a value.`);
      }
      // FR-040A: an untouched placeholder arrives as an empty value and never
      // satisfies a required question.
      const value = raw.value.trim();
      if (value.length === 0) {
        required();
        return undefined;
      }
      if (value.length > question.maxLength) {
        return invalid(
          'answer_too_long',
          `"${question.label}" accepts at most ${question.maxLength} characters.`,
        );
      }
      if (!question.multiline && /[\r\n]/.test(value)) {
        return invalid('invalid_answer', `"${question.label}" accepts a single line.`);
      }
      return { type: 'text', value };
    }

    case 'email': {
      if (!('value' in raw)) {
        return invalid('invalid_answer', `"${question.label}" expects a value.`);
      }
      const value = raw.value.trim();
      if (value.length === 0) {
        required();
        return undefined;
      }
      if (!isValidEmail(value)) {
        return invalid('invalid_email', `"${question.label}" needs a valid email address.`);
      }
      return { type: 'email', value };
    }

    case 'screenshot': {
      if (!('attachmentIds' in raw)) {
        return invalid('invalid_answer', `"${question.label}" expects an attachmentIds array.`);
      }
      const ids = raw.attachmentIds;
      if (ids.length === 0) {
        required();
        return undefined;
      }
      if (ids.length > question.maxCount) {
        return invalid(
          'too_many_attachments',
          `"${question.label}" accepts at most ${question.maxCount} ${question.maxCount === 1 ? 'screenshot' : 'screenshots'}.`,
        );
      }
      return { type: 'screenshot', attachmentIds: ids };
    }
  }
}

/** Accepts both the single-select and multi-select shapes for a choice question. */
function readOptionIds(raw: AnswerInput): string[] | null {
  if ('optionId' in raw) return raw.optionId.length === 0 ? [] : [raw.optionId];
  if ('optionIds' in raw) return raw.optionIds;
  return null;
}
