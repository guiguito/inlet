import { describe, expect, it } from 'vitest';
import { isValidEmail, validateAnswers, type FormDefinition } from '@inlet/shared';
import { ids, referenceDefinition } from '../setup/harness.js';

/**
 * Answer validation (FR-052 to FR-054, FR-093, FR-099A). Pure logic, so it is tested
 * directly rather than through the API.
 */

const f = ids();
const definition = referenceDefinition(f);

function expectFailure(result: ReturnType<typeof validateAnswers>) {
  if (result.ok) throw new Error('expected validation to fail');
  return result.details;
}

describe('validateAnswers', () => {
  it('accepts a minimal valid answer set and normalizes it for storage', () => {
    const result = validateAnswers(definition, {
      [f.mood]: { optionId: f.moodOptions[1] },
      [f.detail]: { value: '  Fix the toggle  ' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.answers[f.mood]).toEqual({ type: 'choice', optionIds: [f.moodOptions[1]] });
    // Values are trimmed on the way in, so trailing whitespace never becomes an answer.
    expect(result.answers[f.detail]).toEqual({ type: 'text', value: 'Fix the toggle' });
    expect(result.attachmentIds).toEqual([]);
  });

  it('reports a missing required answer against its question', () => {
    const details = expectFailure(validateAnswers(definition, {}));
    expect(details.map((d) => [d.questionId, d.code])).toEqual(
      expect.arrayContaining([
        [f.mood, 'missing_required_answer'],
        [f.detail, 'missing_required_answer'],
      ]),
    );
  });

  it('lets optional questions be omitted (FR-053)', () => {
    const result = validateAnswers(definition, {
      [f.mood]: { optionId: f.moodOptions[0] },
      [f.detail]: { value: 'Nothing else' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.answers[f.email]).toBeUndefined();
    expect(result.answers[f.areas]).toBeUndefined();
    expect(result.answers[f.shot]).toBeUndefined();
  });

  it('does not let an empty string satisfy a required free-text question (FR-040A)', () => {
    const details = expectFailure(
      validateAnswers(definition, {
        [f.mood]: { optionId: f.moodOptions[0] },
        [f.detail]: { value: '   ' },
      }),
    );
    expect(details).toEqual([
      expect.objectContaining({ questionId: f.detail, code: 'missing_required_answer' }),
    ]);
  });

  it('rejects an answer to a question the version does not contain', () => {
    const details = expectFailure(
      validateAnswers(definition, {
        ...{ [f.mood]: { optionId: f.moodOptions[0] }, [f.detail]: { value: 'ok' } },
        el_zzzzzzzzzzzz: { value: 'stray' },
      }),
    );
    expect(details).toEqual([
      expect.objectContaining({ questionId: 'el_zzzzzzzzzzzz', code: 'unknown_question' }),
    ]);
  });

  it('rejects an option that does not belong to the question', () => {
    const details = expectFailure(
      validateAnswers(definition, {
        [f.mood]: { optionId: f.areaOptions[0] },
        [f.detail]: { value: 'ok' },
      }),
    );
    expect(details).toEqual([
      expect.objectContaining({ questionId: f.mood, code: 'invalid_option' }),
    ]);
  });

  it('rejects more than one option on a single-select question', () => {
    const details = expectFailure(
      validateAnswers(definition, {
        [f.mood]: { optionIds: [f.moodOptions[0], f.moodOptions[1]] },
        [f.detail]: { value: 'ok' },
      }),
    );
    expect(details).toEqual([
      expect.objectContaining({ questionId: f.mood, code: 'invalid_answer' }),
    ]);
  });

  it('accepts several options on a multi-select question', () => {
    const result = validateAnswers(definition, {
      [f.mood]: { optionId: f.moodOptions[0] },
      [f.areas]: { optionIds: [f.areaOptions[0], f.areaOptions[2]] },
      [f.detail]: { value: 'ok' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.answers[f.areas]).toEqual({
      type: 'choice',
      optionIds: [f.areaOptions[0], f.areaOptions[2]],
    });
  });

  it('rejects the same option listed twice', () => {
    const details = expectFailure(
      validateAnswers(definition, {
        [f.mood]: { optionId: f.moodOptions[0] },
        [f.areas]: { optionIds: [f.areaOptions[0], f.areaOptions[0]] },
        [f.detail]: { value: 'ok' },
      }),
    );
    expect(details).toEqual([
      expect.objectContaining({ questionId: f.areas, code: 'invalid_answer' }),
    ]);
  });

  it('enforces the question’s own character limit', () => {
    const details = expectFailure(
      validateAnswers(definition, {
        [f.mood]: { optionId: f.moodOptions[0] },
        [f.detail]: { value: 'x'.repeat(501) },
      }),
    );
    expect(details).toEqual([
      expect.objectContaining({ questionId: f.detail, code: 'answer_too_long' }),
    ]);
  });

  it('rejects newlines in a single-line question', () => {
    const singleLine: FormDefinition = {
      pages: [
        {
          id: f.page1,
          elements: [
            {
              id: f.detail,
              type: 'text',
              label: 'Headline',
              required: true,
              multiline: false,
              maxLength: 100,
            },
          ],
        },
      ],
    };
    const details = expectFailure(
      validateAnswers(singleLine, { [f.detail]: { value: 'one\ntwo' } }),
    );
    expect(details).toEqual([
      expect.objectContaining({ questionId: f.detail, code: 'invalid_answer' }),
    ]);
  });

  it('rejects an invalid email with a question-level error', () => {
    const details = expectFailure(
      validateAnswers(definition, {
        [f.mood]: { optionId: f.moodOptions[0] },
        [f.detail]: { value: 'ok' },
        [f.email]: { value: 'not-an-email' },
      }),
    );
    expect(details).toEqual([
      expect.objectContaining({ questionId: f.email, code: 'invalid_email' }),
    ]);
  });

  it('collects attachment references and enforces the per-question maximum', () => {
    const ok = validateAnswers(definition, {
      [f.mood]: { optionId: f.moodOptions[0] },
      [f.detail]: { value: 'ok' },
      [f.shot]: { attachmentIds: ['att_aaaaaaaaaaaa', 'att_bbbbbbbbbbbb'] },
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.attachmentIds).toEqual(['att_aaaaaaaaaaaa', 'att_bbbbbbbbbbbb']);

    const details = expectFailure(
      validateAnswers(definition, {
        [f.mood]: { optionId: f.moodOptions[0] },
        [f.detail]: { value: 'ok' },
        [f.shot]: {
          attachmentIds: ['att_1', 'att_2', 'att_3', 'att_4'],
        },
      }),
    );
    expect(details).toEqual([
      expect.objectContaining({ questionId: f.shot, code: 'too_many_attachments' }),
    ]);
  });

  it('rejects the same attachment referenced twice', () => {
    const details = expectFailure(
      validateAnswers(definition, {
        [f.mood]: { optionId: f.moodOptions[0] },
        [f.detail]: { value: 'ok' },
        [f.shot]: { attachmentIds: ['att_same', 'att_same'] },
      }),
    );
    expect(details).toEqual([
      expect.objectContaining({ code: 'attachment_reference_invalid' }),
    ]);
  });

  it('rejects the wrong answer shape for a question type', () => {
    const details = expectFailure(
      validateAnswers(definition, {
        [f.mood]: { value: 'Love it' },
        [f.detail]: { value: 'ok' },
      }),
    );
    expect(details).toEqual([
      expect.objectContaining({ questionId: f.mood, code: 'invalid_answer' }),
    ]);
  });

  it('treats an empty required screenshot answer as unanswered', () => {
    const required: FormDefinition = {
      pages: [
        {
          id: f.page1,
          elements: [
            {
              id: f.shot,
              type: 'screenshot',
              label: 'Proof',
              required: true,
              maxCount: 2,
            },
          ],
        },
      ],
    };
    const details = expectFailure(validateAnswers(required, { [f.shot]: { attachmentIds: [] } }));
    expect(details).toEqual([
      expect.objectContaining({ questionId: f.shot, code: 'missing_required_answer' }),
    ]);
  });
});

describe('isValidEmail', () => {
  it.each([
    'a@b.co',
    'first.last+tag@sub.example.com',
    "o'brien@example.co.uk",
  ])('accepts %s', (value) => {
    expect(isValidEmail(value)).toBe(true);
  });

  it.each([
    '',
    'plain',
    'no@domain',
    'two@@at.com',
    'space in@example.com',
    'trailing@example.com,other@example.com',
    `${'x'.repeat(250)}@example.com`,
  ])('rejects %s', (value) => {
    expect(isValidEmail(value)).toBe(false);
  });
});
