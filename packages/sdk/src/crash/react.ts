import { markFrames, parseStack } from './stack.js';
import type { CaptureOptions, CrashFrame, CrashReportInput } from './types.js';

/**
 * CR-100: the React error-boundary helper, exported separately so that an application
 * without React never loads it.
 *
 * `createErrorBoundary(React, capture)` returns a class component. `capture` is what to
 * do with the report: in a browser or Node, `captureReport` from `@inlet/sdk/crash`; in an
 * Electron renderer, `installElectronRenderer().captureReport`. The component stack React
 * gives an error boundary is turned into frames, one per component, marked in-app,
 * which is what makes a render error group by the component that threw rather than by
 * React's own internals.
 */

type ReactLike = {
  Component: new (...args: never[]) => {
    props: Record<string, unknown>;
    state: unknown;
    setState(state: unknown): void;
  };
  createElement: (...args: unknown[]) => unknown;
};

export type ErrorBoundaryProps = {
  /** Rendered instead of the children after an error. Defaults to nothing. */
  fallback?: unknown;
  children?: unknown;
  tags?: Record<string, string>;
};

export function componentStackToFrames(componentStack: string | null | undefined, appRoots: string[] = []): CrashFrame[] {
  if (!componentStack) return [];
  const frames: CrashFrame[] = [];
  for (const raw of componentStack.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // React 18/19: `at ComponentName (file:line:col)` or `in ComponentName (created by …)`.
    const match = /^(?:at|in)\s+([\w$.<>]+)(?:\s+\((.*?)\))?/.exec(line);
    if (!match) continue;
    const [, name, location] = match;
    if (location && /^[\w$.]+:\/\/|^\//.test(location)) {
      const parsed = parseStack(`    at ${name} (${location})`)[0];
      frames.push(parsed ? markFrames([parsed], appRoots)[0]! : { function: name, inApp: true });
    } else {
      frames.push({ function: name, inApp: true });
    }
  }
  return frames;
}

export function createErrorBoundary(
  React: ReactLike,
  capture: (report: CrashReportInput) => unknown,
  options: { appRoots?: string[]; captureOptions?: CaptureOptions } = {},
) {
  class InletErrorBoundary extends React.Component {
    declare props: ErrorBoundaryProps;
    declare state: { failed: boolean };

    constructor(...args: never[]) {
      super(...args);
      this.state = { failed: false };
    }

    static getDerivedStateFromError(): { failed: boolean } {
      return { failed: true };
    }

    componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
      const frames = componentStackToFrames(info.componentStack, options.appRoots);
      capture({
        kind: 'render-error',
        exception: {
          type: error.name || 'Error',
          message: error.message,
          handled: true,
          frames: frames.length > 0 ? frames : markFrames(parseStack(error.stack), options.appRoots ?? []),
        },
        ...(this.props.tags || options.captureOptions?.tags ? { tags: { ...(options.captureOptions?.tags ?? {}), ...(this.props.tags ?? {}) } } : {}),
        ...(options.captureOptions?.context ? { context: options.captureOptions.context } : {}),
        ...(options.captureOptions?.fingerprint ? { fingerprint: options.captureOptions.fingerprint } : {}),
      });
    }

    render(): unknown {
      return this.state.failed ? (this.props.fallback ?? null) : (this.props.children ?? null);
    }
  }
  return InletErrorBoundary;
}
