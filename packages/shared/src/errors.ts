/**
 * The error model of section 9.5: a stable machine-readable code, a human message,
 * optional field- or question-level details, and an appropriate HTTP status.
 *
 * Every code in ERROR_STATUS is part of the public API contract. Adding a code is a
 * compatible change; changing a code's meaning or status is not.
 */
export const ERROR_STATUS = {
  // --- Request shape -------------------------------------------------------
  malformed_json: 400,
  validation_failed: 400,
  unsupported_media_type: 415,
  payload_too_large: 413,

  // --- Authentication and authorization -----------------------------------
  unauthenticated: 401,
  invalid_credentials: 401,
  invalid_api_key: 401,
  revoked_api_key: 401,
  insufficient_scope: 403,
  forbidden: 403,

  // --- Resources -----------------------------------------------------------
  project_not_found: 404,
  feedback_database_not_found: 404,
  feedback_database_inaccessible: 403,
  submission_not_found: 404,
  attachment_not_found: 404,
  credential_not_found: 404,
  not_found: 404,
  name_conflict: 409,

  // --- Form versions -------------------------------------------------------
  form_not_published: 409,
  form_version_unknown: 404,
  form_version_mismatch: 409,
  form_template_invalid: 400,
  stale_draft_revision: 409,
  no_previous_version: 409,

  // --- Submission intents --------------------------------------------------
  intent_not_found: 404,
  intent_invalid_token: 401,
  intent_expired: 410,
  intent_payload_conflict: 409,
  submission_deleted: 410,

  // --- Answers -------------------------------------------------------------
  unknown_question: 400,
  missing_required_answer: 400,
  invalid_answer: 400,
  invalid_option: 400,
  invalid_email: 400,
  answer_too_long: 400,
  client_context_too_large: 413,

  // --- Attachments ---------------------------------------------------------
  unsupported_image_format: 400,
  animated_image_rejected: 400,
  image_too_many_pixels: 400,
  file_too_large: 413,
  too_many_uploads: 429,
  too_many_attachments: 400,
  attachment_reference_invalid: 400,
  attachment_already_bound: 409,
  /**
   * The malware scanner rejected the file. A client error, not a server fault: the
   * request was understood and refused, and retrying the same bytes cannot help.
   * `upload_failed` was used here originally, which returned 500 and so told an
   * integrator to retry something that will never succeed.
   */
  malware_detected: 400,
  upload_failed: 500,

  // --- Membership (Release 2 surface, codes reserved by the contract) ------
  invitation_invalid: 400,
  invitation_expired: 410,
  invitation_already_redeemed: 409,
  last_admin_removal: 409,

  // --- Notifications -------------------------------------------------------
  /**
   * Slack refused a message. The Slack error string travels in the message and the
   * details, because that is what tells an operator what to fix.
   */
  slack_delivery_failed: 502,

  // --- Platform ------------------------------------------------------------
  rate_limit_exceeded: 429,
  internal_error: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

/** A field- or question-level detail attached to an error response. */
export type ErrorDetail = {
  /** Stable question ID when the problem is with an answer (FR-054). */
  questionId?: string;
  /** Dotted request path when the problem is with a request field. */
  path?: string;
  code: string;
  message: string;
};

export type ApiErrorBody = {
  error: {
    code: ErrorCode;
    message: string;
    details?: ErrorDetail[];
  };
};

export function statusForErrorCode(code: ErrorCode): number {
  return ERROR_STATUS[code];
}
