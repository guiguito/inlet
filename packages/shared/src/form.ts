import { z } from 'zod';
import type {
  BodyTextElement,
  ChoiceOption,
  ChoiceQuestion,
  EmailQuestion,
  FormDefinition,
  FormElement,
  FormPage,
  ScreenshotQuestion,
  SubtitleElement,
  TextQuestion,
  TitleElement,
} from './feedback-core.js';
import { LIMITS } from './limits.js';

/**
 * The form definition schemas (PRD sections 6, 8.4, 10.7 to 10.9), on top of the
 * dependency-free contract in `feedback-core.ts`.
 *
 * A form is an ordered list of pages; a page is one ordered list of elements
 * (FR-032); an element is either a content block or a question (FR-033 to FR-049).
 * Page, element and option identifiers are stable inside a published version
 * (FR-041) so historical answers stay interpretable.
 *
 * The types live in `feedback-core.ts`, which the SDK bundles without Zod (FR-195).
 * `Exact` at the bottom of this file is what keeps the two halves honest: change a
 * schema without changing the type and the build fails here rather than in a client.
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

/**
 * Compile-time proof that each schema still produces the type declared in
 * `feedback-core.ts`. Mutual assignability, so a field added on either side is caught:
 * a schema that gains a key no longer extends the type, and a type that gains one is no
 * longer satisfied by the schema.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
type _SchemasMatchTheTypes = [
  Exact<z.infer<typeof titleElementSchema>, TitleElement>,
  Exact<z.infer<typeof subtitleElementSchema>, SubtitleElement>,
  Exact<z.infer<typeof bodyTextElementSchema>, BodyTextElement>,
  Exact<z.infer<typeof choiceOptionSchema>, ChoiceOption>,
  Exact<z.infer<typeof choiceQuestionSchema>, ChoiceQuestion>,
  Exact<z.infer<typeof textQuestionSchema>, TextQuestion>,
  Exact<z.infer<typeof emailQuestionSchema>, EmailQuestion>,
  Exact<z.infer<typeof screenshotQuestionSchema>, ScreenshotQuestion>,
  Exact<z.infer<typeof elementSchema>, FormElement>,
  Exact<z.infer<typeof pageSchema>, FormPage>,
  Exact<z.infer<typeof formDefinitionSchema>, FormDefinition>,
];
