import { listQuestions, type FormDefinition, type StoredAnswer } from '@inlet/shared';
import type { AppContext } from '../context.js';
import type { AttachmentRow, SubmissionRow } from '../db/schema.js';
import { flattenJson, toCsv } from '../lib/csv.js';
import { allSubmissionsForExport, definitionsForVersions } from './submissions.js';

/**
 * Data export (FR-110 to FR-114, section 9.4).
 *
 * Exports carry raw answers including collected email addresses, the form version of
 * each submission, its timestamp, observed IP and clientContext. Screenshots are
 * represented by their stable authenticated URLs; the files themselves are never
 * bundled, and they do not survive deletion of their feedback database (FR-112).
 */

export type ExportedAttachment = {
  attachmentId: string;
  url: string;
  mediaType: string;
  width: number;
  height: number;
  bytes: number;
};

export type ExportedSubmission = {
  submissionId: string;
  submittedAt: string;
  formVersion: number;
  observedIp: string | null;
  answers: Record<string, StoredAnswer & { attachments?: ExportedAttachment[] }>;
  clientContext: unknown;
};

export type ExportPayload = {
  feedbackDatabaseId: string;
  exportedAt: string;
  submissionCount: number;
  /** FR-112, restated in the payload so a consumer of the file cannot miss it. */
  notice: string;
  submissions: ExportedSubmission[];
};

export const EXPORT_NOTICE =
  'This export contains data only. Screenshot files are not included; download them from their asset URLs before deleting the feedback database.';

/** FR-069: the stable authenticated URL of an attachment. */
export function attachmentUrl(ctx: AppContext, attachmentId: string): string {
  return `${ctx.env.INLET_PUBLIC_URL.replace(/\/$/, '')}/v1/attachments/${attachmentId}`;
}

/** Where a notification sends an operator to read the response itself (FR-159). */
export function submissionUrl(
  ctx: AppContext,
  databaseId: string,
  submissionId: string,
): string {
  const base = ctx.env.INLET_PUBLIC_URL.replace(/\/$/, '');
  return `${base}/databases/${databaseId}/submissions/${submissionId}`;
}

async function collect(
  ctx: AppContext,
  databaseId: string,
): Promise<{
  payload: ExportPayload;
  rows: SubmissionRow[];
  definitions: Map<string, { version: number; definition: FormDefinition }>;
}> {
  const { rows, attachmentsBySubmission } = await allSubmissionsForExport(ctx, databaseId);
  const definitions = await definitionsForVersions(ctx, [
    ...new Set(rows.map((row) => row.formVersionId)),
  ]);

  const submissions = rows.map((row) =>
    exportSubmission(ctx, row, attachmentsBySubmission.get(row.id) ?? []),
  );

  return {
    payload: {
      feedbackDatabaseId: databaseId,
      exportedAt: new Date().toISOString(),
      submissionCount: submissions.length,
      notice: EXPORT_NOTICE,
      submissions,
    },
    rows,
    definitions,
  };
}

/** FR-114: JSON export preserves nested structures as stored. */
export async function exportJson(ctx: AppContext, databaseId: string): Promise<ExportPayload> {
  const { payload } = await collect(ctx, databaseId);
  return payload;
}

/** FR-114 with the flattening rules documented in lib/csv.ts. */
export async function exportCsv(ctx: AppContext, databaseId: string): Promise<string> {
  const { payload, rows, definitions } = await collect(ctx, databaseId);

  const columns = questionColumns(definitions);
  const contextRows = payload.submissions.map((submission) =>
    flattenJson(submission.clientContext, 'context'),
  );
  const contextKeys = [...new Set(contextRows.flatMap((entry) => Object.keys(entry)))].sort();

  const headers = [
    'submission_id',
    'submitted_at',
    'form_version',
    'observed_ip',
    ...columns.map((column) => `${column.label} (${column.questionId})`),
    ...contextKeys,
  ];

  const body = payload.submissions.map((submission, index) => {
    const definition = definitions.get(rows[index]?.formVersionId ?? '')?.definition;
    return [
      submission.submissionId,
      submission.submittedAt,
      String(submission.formVersion),
      submission.observedIp,
      ...columns.map((column) =>
        renderAnswerCell(submission.answers[column.questionId], definition),
      ),
      ...contextKeys.map((key) => contextRows[index]?.[key] ?? ''),
    ];
  });

  return toCsv(headers, body);
}

/** Union of questions across every version in the export, newest version's order first. */
function questionColumns(
  definitions: Map<string, { version: number; definition: FormDefinition }>,
): { questionId: string; label: string }[] {
  const ordered = [...definitions.values()].sort((a, b) => b.version - a.version);
  const columns: { questionId: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const entry of ordered) {
    for (const question of listQuestions(entry.definition)) {
      if (seen.has(question.id)) continue;
      seen.add(question.id);
      columns.push({ questionId: question.id, label: question.label });
    }
  }
  return columns;
}

/**
 * Flattens one stored answer to text.
 *
 * Exported because the Slack message builder needs exactly this, including the two rules
 * with real behaviour in them: an emoji option renders as emoji plus label, and an option
 * that no longer exists in the definition falls back to its raw ID rather than vanishing.
 */
export function renderAnswerCell(
  answer: (StoredAnswer & { attachments?: ExportedAttachment[] }) | undefined,
  definition: FormDefinition | undefined,
): string {
  if (!answer) return '';
  switch (answer.type) {
    case 'text':
    case 'email':
      return answer.value;
    case 'screenshot':
      return (answer.attachments ?? []).map((file) => file.url).join('; ');
    case 'choice':
      return answer.optionIds.map((id) => optionLabel(definition, id)).join('; ');
  }
}

/** Rule 3: an option that no longer exists falls back to its raw ID. */
export function optionLabel(definition: FormDefinition | undefined, optionId: string): string {
  if (!definition) return optionId;
  for (const question of listQuestions(definition)) {
    if (question.type !== 'choice') continue;
    const option = question.options.find((candidate) => candidate.id === optionId);
    if (option) return question.optionKind === 'emoji' && option.emoji
      ? `${option.emoji} ${option.label}`
      : option.label;
  }
  return optionId;
}

function exportSubmission(
  ctx: AppContext,
  row: SubmissionRow,
  files: AttachmentRow[],
): ExportedSubmission {
  const byId = new Map(files.map((file) => [file.id, file]));
  const answers: ExportedSubmission['answers'] = {};

  for (const [questionId, answer] of Object.entries(row.answers)) {
    if (answer.type !== 'screenshot') {
      answers[questionId] = answer;
      continue;
    }
    answers[questionId] = {
      ...answer,
      attachments: answer.attachmentIds.flatMap((id) => {
        const file = byId.get(id);
        if (!file) return [];
        return [
          {
            attachmentId: file.id,
            url: attachmentUrl(ctx, file.id),
            mediaType: file.storedMediaType,
            width: file.width,
            height: file.height,
            bytes: file.storedBytes,
          },
        ];
      }),
    };
  }

  return {
    submissionId: row.id,
    submittedAt: row.createdAt.toISOString(),
    formVersion: row.formVersion,
    observedIp: row.observedIp,
    answers,
    clientContext: row.clientContext,
  };
}
