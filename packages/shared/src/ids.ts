/**
 * Stable identifiers (FR-041). A typed prefix plus 12 characters from a 32-character
 * alphabet that omits i, l, o and u, so an ID read aloud or retyped is unambiguous.
 * 12 characters give 60 bits, ample for identifiers scoped to one form.
 */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export const ID_PREFIXES = {
  page: 'pg',
  element: 'el',
  option: 'op',
  project: 'prj',
  feedbackDatabase: 'fdb',
  formVersion: 'fv',
  submission: 'sub',
  submissionIntent: 'int',
  attachment: 'att',
  credential: 'cred',
  user: 'usr',
  invitation: 'inv',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

/** Cryptographically random ID. Works in Node and in the browser. */
export function newId(kind: IdKind, length = 12): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return `${ID_PREFIXES[kind]}_${out}`;
}

export function isId(kind: IdKind, value: string): boolean {
  const prefix = `${ID_PREFIXES[kind]}_`;
  if (!value.startsWith(prefix)) return false;
  const body = value.slice(prefix.length);
  return body.length > 0 && [...body].every((char) => ALPHABET.includes(char));
}
