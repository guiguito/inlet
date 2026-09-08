import { describe, expect, it } from 'vitest';
import { newId, validateTemplate, type FormDefinition } from '@inlet/shared';
import { ids, referenceDefinition } from '../setup/harness.js';

/** FR-042: a template must be valid before it can be published or used by a client. */
describe('validateTemplate', () => {
  it('accepts the reference form', () => {
    expect(validateTemplate(referenceDefinition(ids()))).toEqual([]);
  });

  it('rejects a form with no pages', () => {
    expect(validateTemplate({ pages: [] })).toEqual([
      expect.objectContaining({ code: 'empty_form' }),
    ]);
  });

  it('rejects an empty page', () => {
    const f = ids();
    const problems = validateTemplate({ pages: [{ id: f.page1, elements: [] }] });
    expect(problems.map((p) => p.code)).toEqual(
      expect.arrayContaining(['empty_page', 'no_questions']),
    );
  });

  it('rejects a form with content blocks but no questions', () => {
    const f = ids();
    const problems = validateTemplate({
      pages: [{ id: f.page1, elements: [{ id: f.title, type: 'title', text: 'Hello' }] }],
    });
    expect(problems).toEqual([expect.objectContaining({ code: 'no_questions' })]);
  });

  it('rejects a duplicated identifier anywhere in the form', () => {
    const f = ids();
    const definition = referenceDefinition(f);
    const page = definition.pages[1];
    if (!page) throw new Error('fixture changed');
    page.elements.push({ id: f.detail, type: 'title', text: 'Duplicate id' });
    expect(validateTemplate(definition)).toEqual([
      expect.objectContaining({ code: 'duplicate_id' }),
    ]);
  });

  it('rejects a duplicated option identifier', () => {
    const f = ids();
    const definition = referenceDefinition(f);
    const page = definition.pages[0];
    const choice = page?.elements.find((e) => e.id === f.areas);
    if (!choice || choice.type !== 'choice') throw new Error('fixture changed');
    choice.options.push({ id: f.areaOptions[0], label: 'Payments again' });
    expect(validateTemplate(definition)).toEqual([
      expect.objectContaining({ code: 'duplicate_id' }),
    ]);
  });

  it('requires an emoji on every option of an emoji choice question', () => {
    const f = ids();
    const definition = referenceDefinition(f);
    const page = definition.pages[0];
    const choice = page?.elements.find((e) => e.id === f.mood);
    if (!choice || choice.type !== 'choice') throw new Error('fixture changed');
    delete choice.options[1]?.emoji;
    expect(validateTemplate(definition)).toEqual([
      expect.objectContaining({ code: 'missing_emoji' }),
    ]);
  });

  it('rejects a choice question with fewer than two options', () => {
    const f = ids();
    const definition: FormDefinition = {
      pages: [
        {
          id: f.page1,
          elements: [
            {
              id: f.areas,
              type: 'choice',
              label: 'Pick one',
              required: true,
              optionKind: 'text',
              selection: 'single',
              orientation: 'vertical',
              options: [{ id: f.areaOptions[0], label: 'Only' }],
            },
          ],
        },
      ],
    };
    expect(validateTemplate(definition).length).toBeGreaterThan(0);
  });

  it('rejects a blank question label', () => {
    const f = ids();
    const definition = referenceDefinition(f);
    const page = definition.pages[1];
    const question = page?.elements.find((e) => e.id === f.detail);
    if (!question || question.type !== 'text') throw new Error('fixture changed');
    question.label = '   ';
    expect(validateTemplate(definition).length).toBeGreaterThan(0);
  });

  it('rejects a screenshot question above the platform maximum', () => {
    const f = ids();
    const definition: FormDefinition = {
      pages: [
        {
          id: f.page1,
          elements: [
            { id: f.shot, type: 'screenshot', label: 'Proof', required: false, maxCount: 9 },
          ],
        },
      ],
    };
    expect(validateTemplate(definition).length).toBeGreaterThan(0);
  });

  it('rejects an unknown element type and an unknown property', () => {
    const f = ids();
    expect(
      validateTemplate({
        pages: [{ id: f.page1, elements: [{ id: f.title, type: 'video', src: 'x' }] }],
      }).length,
    ).toBeGreaterThan(0);

    expect(
      validateTemplate({
        pages: [
          {
            id: f.page1,
            elements: [{ id: f.title, type: 'title', text: 'Hi', colour: 'red' }],
          },
        ],
      }).length,
    ).toBeGreaterThan(0);
  });

  it('rejects a malformed identifier', () => {
    expect(
      validateTemplate({
        pages: [{ id: 'page-1', elements: [{ id: newId('element'), type: 'title', text: 'Hi' }] }],
      }).length,
    ).toBeGreaterThan(0);
  });
});
