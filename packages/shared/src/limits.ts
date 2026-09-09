/**
 * Platform limits. These are non-configurable product constants, not deployment
 * settings: clients read them from the form definition and the API enforces them.
 * PRD section 17 "Recommended defaults, adjustable in technical design".
 */
export const LIMITS = {
  /** FR-062A / section 10.10: clientContext ceiling, serialized as UTF-8. */
  clientContextMaxBytes: 16 * 1024,

  /** FR-099A: total attachments referenced by one finalized submission. */
  submissionMaxAttachments: 5,

  /** FR-045: ceiling for a screenshot question's own maxCount. */
  screenshotQuestionMaxCount: 5,

  /** FR-099A: uploads accepted per intent, bounding abuse independently of the above. */
  intentMaxUploads: 10,

  /**
   * Section 9.3: per uploaded image file, before re-encoding. Screenshots and hosted
   * form logos alike.
   *
   * Generous on the way in because a phone screenshot is routinely several megabytes
   * and rejecting one asks a respondent to go and shrink an image, which is a good way
   * to lose the feedback. What gets stored is bounded separately.
   */
  imageMaxSourceBytes: 10 * 1024 * 1024,

  /**
   * Section 9.3: ceiling for a stored image, after re-encoding.
   *
   * An upload larger than this is not refused: it is re-encoded down until it fits,
   * giving up quality before pixels. Ten megabytes is a reasonable thing to accept and
   * an unreasonable thing to keep, and this is the line between the two.
   */
  imageMaxStoredBytes: 2 * 1024 * 1024,

  /** FR-099: decoded pixel ceiling (width x height) to bound decode cost. */
  attachmentMaxPixels: 25_000_000,

  /** FR-040: ceiling for a free-text question's own maxLength. */
  textAnswerMaxLength: 10_000,

  /** Content-block and label text ceilings, to keep definitions bounded. */
  labelMaxLength: 500,
  helperTextMaxLength: 1_000,
  bodyTextMaxLength: 5_000,
  placeholderMaxLength: 200,

  /** Structural ceilings on a form definition. */
  formMaxPages: 50,
  pageMaxElements: 100,
  choiceMaxOptions: 50,
  choiceMinOptions: 2,

  /** Names. */
  nameMaxLength: 200,
  credentialLabelMaxLength: 100,
} as const;

/** Section 9.3: accepted source media types, validated by content not filename. */
export const ACCEPTED_IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** Every accepted image is re-encoded to this type for storage. */
export const STORED_IMAGE_MEDIA_TYPE = 'image/webp';

/** WebP quality chosen to keep screen text readable (section 9.3). */
export const STORED_IMAGE_QUALITY = 82;

/**
 * How far quality may fall to bring a large image inside the stored-size budget.
 *
 * Quality is spent before pixels: a slightly softer screenshot still reads, while a
 * downscaled one loses the small text that is usually the point of the screenshot.
 */
export const STORED_IMAGE_MIN_QUALITY = 60;

/** The narrowest a stored image is downscaled to, once quality has been spent. */
export const STORED_IMAGE_MIN_WIDTH = 640;
