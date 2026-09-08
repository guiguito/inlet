import { statusForErrorCode, type ApiErrorBody, type ErrorCode, type ErrorDetail } from '@inlet/shared';

/**
 * The one error type every route throws. The global error handler turns it into the
 * section 9.5 response body, so no handler formats errors itself.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: ErrorDetail[];

  constructor(code: ErrorCode, message: string, details?: ErrorDetail[]) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = statusForErrorCode(code);
    if (details && details.length > 0) this.details = details;
  }

  toBody(): ApiErrorBody {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}

export function apiError(code: ErrorCode, message: string, details?: ErrorDetail[]): ApiError {
  return new ApiError(code, message, details);
}

/** Shorthands for the cases that appear in more than one route. */
export const errors = {
  unauthenticated: () => apiError('unauthenticated', 'Sign in to continue.'),
  forbidden: (what = 'You do not have access to this resource.') => apiError('forbidden', what),
  projectNotFound: () => apiError('project_not_found', 'That project does not exist.'),
  databaseNotFound: () =>
    apiError('feedback_database_not_found', 'That feedback database does not exist.'),
  submissionNotFound: () => apiError('submission_not_found', 'That submission does not exist.'),
  attachmentNotFound: () => apiError('attachment_not_found', 'That screenshot does not exist.'),
  credentialNotFound: () => apiError('credential_not_found', 'That credential does not exist.'),
  notPublished: () =>
    apiError('form_not_published', 'This feedback database has no published form.'),
  insufficientScope: (what: string) =>
    apiError('insufficient_scope', `A publishable client key cannot ${what}.`),
};
