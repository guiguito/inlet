import type { FeedbackController } from './controller.js';
import type { AnswerInput, FeedbackSnapshot, Result, ScreenshotSource, SubmitOutcome, UploadedAttachment } from './types.js';

/**
 * FR-209: one binding of the controller, exported separately so that an application
 * without React never loads it.
 *
 * `useFeedbackSession(React, controller)` subscribes the component to the controller and
 * returns the current snapshot with the actions bound. React is a parameter rather than
 * an import, so the package has no peer dependency and nothing here resolves `react` at
 * build time.
 *
 * This is an example, not the way in. A Vue, Svelte or plain-DOM binding is the same
 * three lines against `subscribe` and `getSnapshot`; the README shows one.
 */

type ReactLike = {
  useSyncExternalStore<T>(subscribe: (onChange: () => void) => () => void, getSnapshot: () => T, getServerSnapshot?: () => T): T;
  useMemo<T>(factory: () => T, deps: unknown[]): T;
};

export type FeedbackSessionBinding = FeedbackSnapshot & {
  setAnswer(questionId: string, answer: AnswerInput | undefined): void;
  next(): boolean;
  back(): boolean;
  validatePage(): boolean;
  addScreenshot(questionId: string, file: ScreenshotSource): Promise<Result<UploadedAttachment>>;
  removeScreenshot(questionId: string, attachmentId: string): Promise<void>;
  submit(): Promise<SubmitOutcome>;
  abandon(): void;
};

export function useFeedbackSession(React: ReactLike, controller: FeedbackController): FeedbackSessionBinding {
  const snapshot = React.useSyncExternalStore(
    (onChange) => controller.subscribe(onChange),
    () => controller.getSnapshot(),
    () => controller.getSnapshot(),
  );
  const actions = React.useMemo(
    () => ({
      setAnswer: (questionId: string, answer: AnswerInput | undefined) => controller.setAnswer(questionId, answer),
      next: () => controller.next(),
      back: () => controller.back(),
      validatePage: () => controller.validatePage(),
      addScreenshot: (questionId: string, file: ScreenshotSource) => controller.addScreenshot(questionId, file),
      removeScreenshot: (questionId: string, attachmentId: string) => controller.removeScreenshot(questionId, attachmentId),
      submit: () => controller.submit(),
      abandon: () => controller.abandon(),
    }),
    [controller],
  );
  return { ...snapshot, ...actions };
}
