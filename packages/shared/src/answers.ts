import { z } from 'zod';
import type { AnswerInput, AnswersInput } from './feedback-core.js';
import { LIMITS } from './limits.js';

/**
 * The request schemas for answers, on top of the dependency-free rules in
 * `feedback-core.ts`.
 *
 * `validateAnswers` — the rules that decide whether a set of answers may be submitted —
 * lives there, so that the API and `inlet-sdk/feedback` run the same function and cannot
 * disagree about what a required question means (FR-195). What is left here is the shape
 * check Fastify performs on the request body before any of that runs.
 */
export const answerInputSchema = z.union([
  z.object({ optionId: z.string() }).strict(),
  z.object({ optionIds: z.array(z.string()).max(LIMITS.choiceMaxOptions) }).strict(),
  z.object({ value: z.string() }).strict(),
  z.object({ attachmentIds: z.array(z.string()).max(LIMITS.submissionMaxAttachments) }).strict(),
]);

export const answersInputSchema = z.record(z.string(), answerInputSchema);

/** The schema accepts exactly the four shapes `feedback-core.ts` validates. */
// `false` rather than `never`, each entry through `Assert`: a tuple holding `never` compiles,
// so the earlier form of this check could never fail (release 8 hardening, as `analytics.ts`).
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type _SchemaMatchesTheType = [
  Assert<Exact<z.infer<typeof answerInputSchema>, AnswerInput>>,
  Assert<Exact<z.infer<typeof answersInputSchema>, AnswersInput>>,
];
