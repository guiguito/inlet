import { z } from 'zod';
import { ACCEPTED_IMAGE_MEDIA_TYPES, LIMITS } from './limits.js';

/**
 * The form definition (PRD sections 6, 8.4, 10.7 to 10.9).
 *
 * A form is an ordered list of pages; a page is one ordered list of elements
 * (FR-032); an element is either a content block or a question (FR-033 to FR-049).
 * Page, element and option identifiers are stable inside a published version
 * (FR-041) so historical answers stay interpretable.
 */

/** Stable identifiers: a short typed prefix plus 12 base32 characters. */
export const pageIdSchema = z.string().regex(/^pg_[0-9a-hjkmnp-tv-z]{12}$/, 'invalid page id');
export const elementIdSchema = z.string().regex(/^el_[0-9a-hjkmnp-tv-z]{12}$/, 'invalid element id');
export const optionIdSchema = z.string().regex(/^op_[0-9a-hjkmnp-tv-z]{12}$/, 'invalid option id');

const labelSchema = z.string().trim().min(1, 'label is required').max(LIMITS.labelMaxLength);
const helperTextSchema = z.string().trim().max(LIMITS.helperTextMaxLength).optional();

/** FR-033: content blocks. */
const contentTextSchema = z.string().trim().min(1, 'text is required').max(LIMITS.bodyTextMaxLength);

export const titleElementSchema = z
  .object({ id: elementIdSchema, type: z.literal('title'), text: contentTextSchema })
  .strict();

export const subtitleElementSchema = z
  .object({ id: elementIdSchema, type: z.literal('subtitle'), text: contentTextSchema })
  .strict();

export const bodyTextElementSchema = z
  .object({ id: elementIdSchema, type: z.literal('body_text'), text: contentTextSchema })
  .strict();

/**
 * FR-035 to FR-037: one choice element covers both text options and emoji options.
 * `optionKind` distinguishes them, `selection` covers single- and multi-select, and
 * `orientation` carries the horizontal or vertical presentation setting.
 */
export const choiceOptionSchema = z
  .object({
    id: optionIdSchema,
    label: labelSchema,
    /** Required when the question's optionKind is "emoji", ignored otherwise. */
    emoji: z.string().trim().min(1).max(16).optional(),
  })
  .strict();

export const choiceQuestionSchema = z
  .object({
    id: elementIdSchema,
    type: z.literal('choice'),
    label: labelSchema,
    helperText: helperTextSchema,
    required: z.boolean(),
    optionKind: z.enum(['text', 'emoji']),
    selection: z.enum(['single', 'multi']),
    orientation: z.enum(['vertical', 'horizontal']),
    options: z.array(choiceOptionSchema).min(LIMITS.choiceMinOptions).max(LIMITS.choiceMaxOptions),
  })
  .strict();

/**
 * FR-038 to FR-040A: single- and multi-line free text with a character limit and
 * placeholder guidance. Placeholder text is never a default answer.
 */
export const textQuestionSchema = z
  .object({
    id: elementIdSchema,
    type: z.literal('text'),
    label: labelSchema,
    helperText: helperTextSchema,
    required: z.boolean(),
    multiline: z.boolean(),
    maxLength: z.int().min(1).max(LIMITS.textAnswerMaxLength),
    placeholder: z.string().max(LIMITS.placeholderMaxLength).optional(),
  })
  .strict();

/** FR-048, FR-049: email question with configurable label, helper text and requiredness. */
export const emailQuestionSchema = z
  .object({
    id: elementIdSchema,
    type: z.literal('email'),
    label: labelSchema,
    helperText: helperTextSchema,
    required: z.boolean(),
    placeholder: z.string().max(LIMITS.placeholderMaxLength).optional(),
  })
  .strict();

/**
 * FR-043 to FR-046: screenshot upload question. `acceptedMediaTypes` and
 * `maxFileBytes` are platform-owned; they are injected when the definition is served
 * to a client so published versions stay immutable while limits stay current.
 */
export const screenshotQuestionSchema = z
  .object({
    id: elementIdSchema,
    type: z.literal('screenshot'),
    label: labelSchema,
    helperText: helperTextSchema,
    required: z.boolean(),
    maxCount: z.int().min(1).max(LIMITS.screenshotQuestionMaxCount),
  })
  .strict();

export const elementSchema = z.discriminatedUnion('type', [
  titleElementSchema,
  subtitleElementSchema,
  bodyTextElementSchema,
  choiceQuestionSchema,
  textQuestionSchema,
  emailQuestionSchema,
  screenshotQuestionSchema,
]);

export const pageSchema = z
  .object({
    id: pageIdSchema,
    elements: z.array(elementSchema).max(LIMITS.pageMaxElements),
  })
  .strict();

/** The stored shape of a draft or published version. */
export const formDefinitionSchema = z
  .object({ pages: z.array(pageSchema).max(LIMITS.formMaxPages) })
  .strict();

export type TitleElement = z.infer<typeof titleElementSchema>;
export type SubtitleElement = z.infer<typeof subtitleElementSchema>;
export type BodyTextElement = z.infer<typeof bodyTextElementSchema>;
export type ChoiceOption = z.infer<typeof choiceOptionSchema>;
export type ChoiceQuestion = z.infer<typeof choiceQuestionSchema>;
export type TextQuestion = z.infer<typeof textQuestionSchema>;
export type EmailQuestion = z.infer<typeof emailQuestionSchema>;
export type ScreenshotQuestion = z.infer<typeof screenshotQuestionSchema>;
export type FormElement = z.infer<typeof elementSchema>;
export type FormPage = z.infer<typeof pageSchema>;
export type FormDefinition = z.infer<typeof formDefinitionSchema>;

export type QuestionElement = ChoiceQuestion | TextQuestion | EmailQuestion | ScreenshotQuestion;
export type ContentElement = TitleElement | SubtitleElement | BodyTextElement;

export const QUESTION_TYPES = ['choice', 'text', 'email', 'screenshot'] as const;
export const CONTENT_TYPES = ['title', 'subtitle', 'body_text'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];
export type ElementType = FormElement['type'];

export function isQuestion(element: FormElement): element is QuestionElement {
  return (QUESTION_TYPES as readonly string[]).includes(element.type);
}

export function isContentBlock(element: FormElement): element is ContentElement {
  return (CONTENT_TYPES as readonly string[]).includes(element.type);
}

/** Every question in the definition, in authored order. */
export function listQuestions(definition: FormDefinition): QuestionElement[] {
  return definition.pages.flatMap((page) => page.elements.filter(isQuestion));
}

/** Questions by stable ID, for answer validation and submission rendering. */
export function questionsById(definition: FormDefinition): Map<string, QuestionElement> {
  return new Map(listQuestions(definition).map((q) => [q.id, q]));
}

/**
 * The client-facing shape of a screenshot question: the stored definition plus the
 * platform-owned limits required by FR-046.
 */
export type ClientScreenshotQuestion = ScreenshotQuestion & {
  acceptedMediaTypes: readonly string[];
  maxFileBytes: number;
};

export type ClientFormElement = Exclude<FormElement, ScreenshotQuestion> | ClientScreenshotQuestion;
export type ClientFormPage = { id: string; elements: ClientFormElement[] };
export type ClientFormDefinition = { pages: ClientFormPage[] };

/** Injects the platform-owned upload limits into every screenshot question (FR-046). */
export function toClientDefinition(definition: FormDefinition): ClientFormDefinition {
  return {
    pages: definition.pages.map((page) => ({
      id: page.id,
      elements: page.elements.map((element) =>
        element.type === 'screenshot'
          ? {
              ...element,
              acceptedMediaTypes: ACCEPTED_IMAGE_MEDIA_TYPES,
              maxFileBytes: LIMITS.imageMaxSourceBytes,
            }
          : element,
      ),
    })),
  };
}
