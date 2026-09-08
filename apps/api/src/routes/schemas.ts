import { z } from 'zod';
import {
  ERROR_STATUS,
  LIMITS,
  formDefinitionSchema,
  answersInputSchema,
  ROLES,
} from '@inlet/shared';

/**
 * Request and response schemas.
 *
 * Zod is the single source of truth: fastify-type-provider-zod validates requests
 * against these schemas and @fastify/swagger renders the same schemas into the
 * OpenAPI document, so the published contract cannot drift from what the server
 * actually accepts.
 */

/**
 * The acknowledgement body for operations with nothing to return.
 *
 * A JSON body rather than a bare 204: the Zod serializer needs a declared response
 * shape for a status code to be typed and documented, and a 204 with a serialized
 * body is not valid HTTP. One predictable envelope beats an undocumented status.
 */
export const okSchema = z.object({ ok: z.literal(true) });

export const errorResponseSchema = z
  .object({
    error: z.object({
      code: z.enum(Object.keys(ERROR_STATUS) as [string, ...string[]]).describe('Stable machine-readable error code.'),
      message: z.string().describe('Human-readable explanation.'),
      details: z
        .array(
          z.object({
            questionId: z.string().optional(),
            path: z.string().optional(),
            code: z.string(),
            message: z.string(),
          }),
        )
        .optional()
        .describe('Field- or question-level detail, when relevant.'),
    }),
  })
  .describe('The error shape used by every Inlet endpoint (PRD section 9.5).');

/** Attached to routes so their failure modes appear in the OpenAPI document. */
export const errorResponses = {
  400: errorResponseSchema,
  401: errorResponseSchema,
  403: errorResponseSchema,
  404: errorResponseSchema,
  409: errorResponseSchema,
  410: errorResponseSchema,
  413: errorResponseSchema,
  415: errorResponseSchema,
  429: errorResponseSchema,
  500: errorResponseSchema,
} as const;

/** Subsets, so a route only documents the statuses it can actually return. */
export function errorsFor<K extends keyof typeof errorResponses>(
  ...codes: K[]
): Pick<typeof errorResponses, K> {
  return Object.fromEntries(codes.map((code) => [code, errorResponses[code]])) as Pick<
    typeof errorResponses,
    K
  >;
}

const nameSchema = z.string().trim().min(1).max(LIMITS.nameMaxLength);

export const projectIdParam = z.object({ projectId: z.string().min(1) });
export const databaseIdParam = z.object({ databaseId: z.string().min(1) });
export const credentialIdParam = projectIdParam.extend({ credentialId: z.string().min(1) });
export const submissionIdParam = databaseIdParam.extend({ submissionId: z.string().min(1) });
export const intentIdParam = databaseIdParam.extend({ intentId: z.string().min(1) });
export const attachmentIdParam = z.object({ attachmentId: z.string().min(1) });

// --- Authentication ---------------------------------------------------------

export const signInBodySchema = z.object({
  email: z.string().trim().min(3).max(320),
  password: z.string().min(1).max(1024),
});

export const currentUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
});

// --- Projects ---------------------------------------------------------------

export const createProjectBodySchema = z.object({ name: nameSchema });
export const renameProjectBodySchema = z.object({ name: nameSchema });

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(ROLES),
  feedbackDatabaseCount: z.int(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

// --- Feedback databases -----------------------------------------------------

export const createDatabaseBodySchema = z.object({ name: nameSchema });
export const renameDatabaseBodySchema = z.object({ name: nameSchema });

export const feedbackDatabaseSchema = z.object({
  id: z.string().describe('The stable public identifier used by client applications (FR-021).'),
  projectId: z.string(),
  name: z.string(),
  activeFormVersion: z.int().nullable().describe('Null when the form is unpublished.'),
  submissionCount: z.int(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const deletionImpactSchema = z.object({
  submissions: z.int(),
  attachments: z.int(),
  notice: z.string(),
});

// --- Form drafts and versions ----------------------------------------------

export const draftSchema = z.object({
  feedbackDatabaseId: z.string(),
  definition: formDefinitionSchema,
  revision: z.int().describe('Increments on every autosave (FR-042A).'),
  updatedAt: z.date(),
  problems: z
    .array(z.object({ path: z.string().optional(), code: z.string(), message: z.string() }))
    .describe('Why this draft cannot be published yet. Empty when it is publishable.'),
});

export const saveDraftBodySchema = z.object({ definition: formDefinitionSchema });

export const publishBodySchema = z.object({
  expectedRevision: z
    .int()
    .optional()
    .describe('Reject the publish if the draft has moved past this revision (FR-042C).'),
});

export const formVersionSchema = z.object({
  id: z.string(),
  feedbackDatabaseId: z.string(),
  version: z.int(),
  definition: formDefinitionSchema,
  sourceRevision: z.int(),
  publishedAt: z.date(),
  active: z.boolean(),
});

export const rollbackBodySchema = z.object({
  version: z.int().min(1).optional().describe('Defaults to the most recent inactive version.'),
});

// --- Credentials ------------------------------------------------------------

export const createCredentialBodySchema = z.object({
  type: z.enum(['publishable', 'secret']),
  label: z.string().trim().min(1).max(LIMITS.credentialLabelMaxLength),
});

export const relabelCredentialBodySchema = z.object({
  label: z.string().trim().min(1).max(LIMITS.credentialLabelMaxLength),
});

export const credentialSchema = z.object({
  id: z.string(),
  type: z.enum(['publishable', 'secret']),
  label: z.string(),
  key: z.string().nullable().describe('The publishable key value. Null for secret keys.'),
  prefix: z.string(),
  lastFour: z.string(),
  createdAt: z.date(),
  lastUsedAt: z.date().nullable(),
  rotatedAt: z.date().nullable(),
  revokedAt: z.date().nullable(),
});

export const credentialWithSecretSchema = credentialSchema.extend({
  secret: z
    .string()
    .describe('The full key. A secret server key is shown here once and never again (FR-084).'),
});

// --- Client feedback flow ---------------------------------------------------

const clientElementSchema = z.looseObject({
  id: z.string(),
  type: z.enum(['title', 'subtitle', 'body_text', 'choice', 'text', 'email', 'screenshot']),
});

export const clientFormSchema = z.object({
  feedbackDatabaseId: z.string(),
  formVersionId: z.string(),
  formVersion: z.int(),
  publishedAt: z.date(),
  pages: z.array(z.object({ id: z.string(), elements: z.array(clientElementSchema) })),
});

/**
 * Nullish rather than optional: a POST sent with no body at all arrives as null once
 * Fastify has parsed it, and creating an intent for the active version should not
 * require the caller to send `{}`.
 */
export const createIntentBodySchema = z
  .object({
    formVersion: z
      .int()
      .min(1)
      .optional()
      .describe('The version the client rendered. Defaults to the active version.'),
  })
  .nullish();

export const intentSchema = z.object({
  intentId: z.string(),
  token: z.string().describe('Single-use bearer token for uploads and finalization.'),
  formVersion: z.int().describe('The pinned version. Finalization must name this value.'),
  expiresAt: z.date(),
});

export const finalizeBodySchema = z.object({
  formVersion: z.int().min(1).describe('Must equal the version pinned on the intent (FR-094).'),
  answers: answersInputSchema.describe('Answers keyed by stable question ID.'),
  clientContext: z
    .unknown()
    .optional()
    .describe(
      `Arbitrary JSON kept as supplied, at most ${LIMITS.clientContextMaxBytes} bytes as UTF-8.`,
    ),
});

export const finalizeResultSchema = z.object({
  submissionId: z.string(),
  status: z
    .enum(['accepted', 'duplicate'])
    .describe('"duplicate" means this intent had already been finalized with this payload.'),
  formVersion: z.int(),
  createdAt: z.date(),
});

export const uploadResultSchema = z.object({
  attachmentId: z.string().describe('Reference this ID in the submission payload.'),
  status: z.literal('uploaded'),
  mediaType: z.string().describe('Stored media type. Always image/webp.'),
  originalMediaType: z.string(),
  width: z.int(),
  height: z.int(),
  bytes: z.int(),
  originalBytes: z.int(),
});

// --- Submissions ------------------------------------------------------------

const storedAnswerSchema = z.union([
  z.object({ type: z.literal('choice'), optionIds: z.array(z.string()) }),
  z.object({ type: z.literal('text'), value: z.string() }),
  z.object({ type: z.literal('email'), value: z.string() }),
  z.object({ type: z.literal('screenshot'), attachmentIds: z.array(z.string()) }),
]);

export const submissionSummarySchema = z.object({
  id: z.string(),
  formVersion: z.int(),
  createdAt: z.date(),
  observedIp: z.string().nullable(),
  answers: z.record(z.string(), storedAnswerSchema),
  clientContext: z.unknown().nullable(),
  attachmentCount: z.int(),
});

export const attachmentSchema = z.object({
  id: z.string(),
  questionId: z.string(),
  url: z.string().describe('Stable authenticated URL. Every request is authorized (FR-069).'),
  mediaType: z.string(),
  width: z.int(),
  height: z.int(),
  bytes: z.int(),
  originalMediaType: z.string(),
  originalFilename: z.string().nullable(),
  createdAt: z.date(),
});

export const submissionDetailSchema = submissionSummarySchema.extend({
  formDefinition: formDefinitionSchema.describe(
    'The definition this submission was made against, for label-accurate display (FR-065).',
  ),
  attachments: z.array(attachmentSchema),
});

export const submissionListSchema = z.object({
  submissions: z.array(submissionSummarySchema),
  nextCursor: z.string().nullable(),
  total: z.int(),
});

export const listSubmissionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export const exportQuerySchema = z.object({
  format: z.enum(['json', 'csv']).default('json'),
});

export const deletedSchema = z.object({
  deleted: z.literal(true),
  purgedKeys: z.int().describe('Screenshot objects queued for asynchronous purge (FR-027).'),
});
