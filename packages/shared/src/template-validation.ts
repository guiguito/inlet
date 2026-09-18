import type { ErrorDetail } from './errors.js';
import { formDefinitionSchema } from './form.js';
import { isQuestion, type FormDefinition } from './feedback-core.js';
import { LIMITS } from './limits.js';

/**
 * FR-042: the template must be valid before it can be published or used by a client.
 *
 * Structural rules live in the Zod schema; the rules below are the ones a schema
 * cannot express: cross-element identifier uniqueness, non-empty pages, and the
 * requirement that a publishable form actually asks something.
 */
export function validateTemplate(definition: unknown): ErrorDetail[] {
  const parsed = formDefinitionSchema.safeParse(definition);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      code: issue.code,
      message: issue.message,
    }));
  }
  return validateParsedTemplate(parsed.data);
}

/** The semantic rules, for a definition that already matches the schema. */
export function validateParsedTemplate(definition: FormDefinition): ErrorDetail[] {
  const details: ErrorDetail[] = [];
  const seenIds = new Set<string>();
  let questionCount = 0;

  if (definition.pages.length === 0) {
    details.push({
      path: 'pages',
      code: 'empty_form',
      message: 'A form needs at least one page.',
    });
  }

  definition.pages.forEach((page, pageIndex) => {
    const pagePath = `pages.${pageIndex}`;

    if (seenIds.has(page.id)) {
      details.push({
        path: `${pagePath}.id`,
        code: 'duplicate_id',
        message: `The identifier ${page.id} is used more than once.`,
      });
    }
    seenIds.add(page.id);

    if (page.elements.length === 0) {
      details.push({
        path: `${pagePath}.elements`,
        code: 'empty_page',
        message: `Page ${pageIndex + 1} needs at least one element.`,
      });
    }

    page.elements.forEach((element, elementIndex) => {
      const elementPath = `${pagePath}.elements.${elementIndex}`;

      if (seenIds.has(element.id)) {
        details.push({
          path: `${elementPath}.id`,
          code: 'duplicate_id',
          message: `The identifier ${element.id} is used more than once.`,
        });
      }
      seenIds.add(element.id);

      if (isQuestion(element)) questionCount += 1;

      if (element.type === 'choice') {
        element.options.forEach((option, optionIndex) => {
          const optionPath = `${elementPath}.options.${optionIndex}`;
          if (seenIds.has(option.id)) {
            details.push({
              path: `${optionPath}.id`,
              code: 'duplicate_id',
              message: `The identifier ${option.id} is used more than once.`,
            });
          }
          seenIds.add(option.id);

          if (element.optionKind === 'emoji' && !option.emoji) {
            details.push({
              path: `${optionPath}.emoji`,
              code: 'missing_emoji',
              message: `Option ${optionIndex + 1} of "${element.label}" needs an emoji.`,
            });
          }
        });
      }

      if (element.type === 'screenshot' && element.maxCount > LIMITS.submissionMaxAttachments) {
        details.push({
          path: `${elementPath}.maxCount`,
          code: 'above_platform_limit',
          message: `A screenshot question accepts at most ${LIMITS.submissionMaxAttachments} files.`,
        });
      }
    });
  });

  if (definition.pages.length > 0 && questionCount === 0) {
    details.push({
      path: 'pages',
      code: 'no_questions',
      message: 'A form needs at least one question before it can be published.',
    });
  }

  return details;
}
