import { uuidV7 } from '@inlet/shared/crash-core';

type RandomSource = (bytes: Uint8Array) => void;

/**
 * The SDK identity (Foundations FD-016, Crash Reports CR-118, Feedback Collection FR-204).
 *
 * One per application, whatever entry created it, through a key on `globalThis` as the
 * crash client already is (CR-110): every entry is bundled standalone, so a module
 * variable would be a separate identity in each of them.
 *
 * What lives here:
 *
 * - the **session ID**, a UUID v7 that rotates after 30 minutes without activity and
 *   after 24 hours, in memory. A new process or page load begins a new one, which is
 *   FD-016's "at each process start outside browsers" and its in-memory rule for a
 *   browser without analytics. Activity in any module extends it.
 * - the **user ID**, set by any module's `setUser`, in memory.
 * - the **installation ID**, which only the analytics module creates (Release 8). Until
 *   one is attached nothing sets it, so the crash and feedback modules never send one.
 *
 * Nothing here is written to the device: FD-016 writes identity only while an analytics
 * client is enabled, and the analytics module owns that persistence when it arrives.
 */

export const SESSION_TIMEOUT_MS = 30 * 60_000;
export const SESSION_MAX_AGE_MS = 24 * 60 * 60_000;

export class Identity {
  private session: { id: string; startedAt: number; lastActivityAt: number } | null = null;
  private random: RandomSource | undefined;
  userId: string | null = null;
  /** Set by the analytics module while one is enabled (FD-016). Null otherwise. */
  installationId: string | null = null;

  /** The first injected source of random values wins; React Native adapters supply one (AN-239). */
  useRandom(source: RandomSource | undefined): void {
    this.random ??= source;
  }

  /**
   * The current session ID, rotated first if it expired. `activity` extends it; a read
   * that is not activity, such as a report describing the previous run, passes false.
   */
  sessionId(now: number, activity = true): string {
    const current = this.session;
    if (!current || now - current.lastActivityAt > SESSION_TIMEOUT_MS || now - current.startedAt > SESSION_MAX_AGE_MS) {
      this.session = { id: uuidV7(now, this.random), startedAt: now, lastActivityAt: now };
      return this.session.id;
    }
    if (activity) current.lastActivityAt = now;
    return current.id;
  }
}

const SLOT = Symbol.for('inlet-sdk.identity');

export function sharedIdentity(): Identity {
  const holder = globalThis as unknown as { [SLOT]?: Identity };
  holder[SLOT] ??= new Identity();
  return holder[SLOT];
}

/** Tests start each case with a fresh identity. */
export function resetSharedIdentity(): void {
  delete (globalThis as unknown as { [SLOT]?: Identity })[SLOT];
}
