import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The unclean-exit sentinel (CR-116).
 *
 * A hang, a Force Quit, a power loss and an OOM kill all leave nothing behind by definition:
 * no handler runs, so nothing can report them from inside the dying process. The only way to
 * see them is the inverse trick — write a file while alive, remove it on a clean quit, and if
 * it is still there on the next launch, the previous run died without quitting.
 *
 * The file's CONTENT is the start time and its MTIME is the last touch, so the previous run's
 * uptime is `mtime - startedAt`. Two timestamps in one file, and the touch is what keeps the
 * second one honest without rewriting the first.
 *
 * `FileStore` deliberately does not back this. It has no delete of any kind — there would be
 * no way to disarm on a clean quit — and its writes serialize behind the crash queue, so a
 * periodic touch would contend with the reports it exists to protect.
 */

export type PreviousRun = {
  /** Absent when the file was unreadable: the crash still happened, the uptime is just unknown. */
  lastUptimeMs?: number;
};

export type SentinelOptions = {
  /** Where the sentinel lives. Its directory is created if needed. */
  file: string;
  now: () => number;
  /** How often the mtime is refreshed. */
  intervalMs: number;
  debug: (message: string, detail?: unknown) => void;
};

export type Sentinel = {
  /** The previous run, when it never quit cleanly. Null when the last quit was clean. */
  previous: PreviousRun | null;
  /** Disarms: stops the timer and removes the file, so the next launch reports nothing. */
  stop: () => void;
};

/**
 * Reads whatever the last run left, then arms this one. The read comes first — writing before
 * reading would destroy the very evidence this exists to collect.
 */
export function startSentinel(options: SentinelOptions): Sentinel {
  const previous = readPrevious(options);
  write(options, options.now());

  const timer = setInterval(() => {
    try {
      write(options, undefined);
    } catch (error) {
      options.debug('The unclean-exit sentinel could not be refreshed.', error);
    }
  }, options.intervalMs);
  // The sentinel must never be the reason a process stays alive.
  (timer as unknown as { unref?: () => void }).unref?.();

  let stopped = false;
  return {
    previous,
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer as unknown as ReturnType<typeof setTimeout>);
      try {
        if (existsSync(options.file)) unlinkSync(options.file);
      } catch (error) {
        options.debug('The unclean-exit sentinel could not be removed; the next launch may report a crash that did not happen.', error);
      }
    },
  };
}

function readPrevious(options: SentinelOptions): PreviousRun | null {
  let raw: string;
  let touchedAt: number;
  try {
    if (!existsSync(options.file)) return null;
    raw = readFileSync(options.file, 'utf8');
    touchedAt = statSync(options.file).mtimeMs;
  } catch (error) {
    options.debug('The unclean-exit sentinel could not be read.', error);
    return null;
  }
  // A corrupt file still reports. The previous run died either way, and discarding it is the
  // one outcome that loses information; an unknown uptime is a smaller loss than a lost crash.
  try {
    const parsed = JSON.parse(raw) as { startedAt?: unknown };
    const startedAt = typeof parsed?.startedAt === 'number' ? parsed.startedAt : null;
    if (startedAt === null) return {};
    const uptime = Math.round(touchedAt) - startedAt;
    return uptime >= 0 ? { lastUptimeMs: uptime } : {};
  } catch {
    return {};
  }
}

/**
 * Writes the sentinel. With a `startedAt` it stamps a new run; without one it rewrites what is
 * already there, which is what moves the mtime forward. Staged through a temporary file and
 * renamed, so a process that dies mid-write leaves the previous sentinel intact rather than a
 * truncated one — the same shape `FileStore` uses.
 */
function write(options: SentinelOptions, startedAt: number | undefined): void {
  let body: string;
  if (startedAt !== undefined) {
    body = JSON.stringify({ startedAt });
  } else {
    try {
      body = readFileSync(options.file, 'utf8');
    } catch {
      // Something removed it underneath us; re-arm from now rather than stop reporting.
      body = JSON.stringify({ startedAt: options.now() });
    }
  }
  mkdirSync(dirname(options.file), { recursive: true });
  const staging = `${options.file}.${process.pid}.tmp`;
  writeFileSync(staging, body);
  renameSync(staging, options.file);
}
