import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createElectronRenderer, installElectronMain, IPC_CHANNEL, type ElectronModule, type FeedbackRequest } from '../src/feedback/electron.js';
import { useFeedbackSession } from '../src/feedback/react.js';
import { FeedbackClient } from '../src/feedback/client.js';
import { MemoryStore } from '../src/store.js';
import { FakeInlet, QUESTION, pngBytes } from './feedback-server.js';

/**
 * The two bindings and the process boundary (FR-208, FR-209).
 *
 * Neither React nor Electron is installed in this package, which is the point of both
 * requirements: the React entry takes React as a parameter, and the Electron entry takes
 * its module lazily. What stands in for them here is what an integrator would pass.
 */

const KEY = 'ipk_testtesttesttest';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function client(server: FakeInlet) {
  return new FeedbackClient({
    baseUrl: 'https://inlet.example',
    publishableKey: KEY,
    feedbackDatabaseId: 'fdb_test',
    fetch: server.fetch,
    store: new MemoryStore(),
  });
}

// --- React (FR-209) ------------------------------------------------------------------

/**
 * Just enough React to run the hook: `useSyncExternalStore` as React implements it, and a
 * `useMemo` that recomputes when the dependency changes. A render is one call of the hook.
 */
function fakeReact() {
  let renders = 0;
  let onChange: (() => void) | null = null;
  let memo: { deps: unknown[]; value: unknown } | null = null;
  const React = {
    useSyncExternalStore<T>(subscribe: (cb: () => void) => () => void, getSnapshot: () => T): T {
      if (!onChange) {
        onChange = () => {
          renders += 1;
        };
        subscribe(onChange);
      }
      return getSnapshot();
    },
    useMemo<T>(factory: () => T, deps: unknown[]): T {
      if (!memo || memo.deps.some((dep, index) => dep !== deps[index])) {
        memo = { deps, value: factory() };
      }
      return memo.value as T;
    },
  };
  return { React, renders: () => renders };
}

describe('useFeedbackSession', () => {
  it('re-renders on every snapshot change and binds the actions', async () => {
    const server = new FakeInlet();
    const created = await client(server).createSession();
    if (!created.ok) throw new Error('no session');
    const controller = created.value;
    const { React, renders } = fakeReact();

    let bound = useFeedbackSession(React, controller);
    expect(bound.pageIndex).toBe(0);
    expect(renders()).toBe(0);

    bound.setAnswer(QUESTION.mood, { optionId: 'op_aaaaaaaaaaaa' });
    expect(renders()).toBe(1);
    bound = useFeedbackSession(React, controller);
    expect(bound.answers[QUESTION.mood]).toEqual({ optionId: 'op_aaaaaaaaaaaa' });

    expect(bound.next()).toBe(true);
    expect(renders()).toBe(2);
    bound = useFeedbackSession(React, controller);
    expect(bound.pageIndex).toBe(1);
    expect(bound.isLastPage).toBe(true);
  });

  it('is one binding among others: a plain subscriber drives the same controller', async () => {
    const server = new FakeInlet();
    const created = await client(server).createSession();
    if (!created.ok) throw new Error('no session');
    const controller = created.value;

    // What a Vue, Svelte or plain-DOM binding is: subscribe, read, act.
    const drawn: number[] = [];
    controller.subscribe((snapshot) => drawn.push(snapshot.pageIndex));
    controller.setAnswer(QUESTION.mood, { optionId: 'op_aaaaaaaaaaaa' });
    controller.next();
    expect(drawn).toEqual([0, 1]);
  });
});

// --- Electron (FR-208) ----------------------------------------------------------------

/** A fake `electron`: one handler registered by main, and a sender back to the renderer. */
function fakeElectron(): ElectronModule & {
  invoke: (channel: string, request: FeedbackRequest) => Promise<unknown>;
  on: (channel: string, listener: (payload: unknown) => void) => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'inlet-feedback-'));
  dirs.push(dir);
  const handlers = new Map<string, (event: unknown, request: unknown) => unknown>();
  const listeners = new Map<string, ((payload: unknown) => void)[]>();
  const sender = {
    send: (channel: string, payload: unknown) => {
      for (const listener of listeners.get(channel) ?? []) listener(payload);
    },
  };
  return {
    app: { getPath: () => dir },
    ipcMain: {
      handle: (channel, listener) => handlers.set(channel, listener as never),
      removeHandler: (channel) => handlers.delete(channel),
    },
    invoke: async (channel, request) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`no handler for ${channel}`);
      // Structured clone is what a real channel does; doing it here proves the payload
      // survives it, which an ArrayBuffer does and a Blob does not.
      return handler({ sender }, structuredClone(request));
    },
    on: (channel, listener) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
    },
  };
}

describe('the Electron adapter', () => {
  it('keeps the key in main, drives the session from the renderer, and never gives out the token', async () => {
    const server = new FakeInlet();
    const electron = fakeElectron();
    const observed: FeedbackRequest['op'][] = [];

    const main = await installElectronMain(
      { baseUrl: 'https://inlet.example', publishableKey: KEY, feedbackDatabaseId: 'fdb_test', fetch: server.fetch },
      { electron },
    );

    const renderer = createElectronRenderer({
      invoke: (channel, request) => {
        expect(channel).toBe(IPC_CHANNEL);
        observed.push(request.op);
        return electron.invoke(channel, request);
      },
      on: electron.on,
    });

    const created = await renderer.createSession();
    if (!created.ok) throw new Error(`no session: ${created.error.code}`);
    const controller = created.value;

    controller.setAnswer(QUESTION.mood, { optionId: 'op_aaaaaaaaaaaa' });
    controller.next();
    controller.setAnswer(QUESTION.detail, { value: 'The window went blank.' });
    const uploaded = await controller.addScreenshot(QUESTION.shot, pngBytes());
    expect(uploaded.ok).toBe(true);
    const outcome = await controller.submit();
    expect(outcome.status).toBe('accepted');

    // Every network step went over the channel, and no other kind of request exists.
    expect(observed).toEqual(['getForm', 'createIntent', 'upload', 'finalize']);
    // The renderer never saw the token; main kept it and matched it by intent ID.
    const finalize = server.collectionCalls().find((call) => call.url.endsWith('/submit'))!;
    expect(finalize.headers['x-inlet-intent-token']).toMatch(/^tok_/);
    expect(finalize.headers.authorization).toBe(`Bearer ${KEY}`);

    main.uninstall();
    await main.client.close(100);
  });

  it('tells the renderer when main finally delivers a submission the network had lost', async () => {
    let clock = 1_000_000;
    const server = new FakeInlet({ now: () => clock });
    const electron = fakeElectron();
    const main = await installElectronMain(
      { baseUrl: 'https://inlet.example', publishableKey: KEY, feedbackDatabaseId: 'fdb_test', fetch: server.fetch, now: () => clock },
      { electron },
    );
    const renderer = createElectronRenderer({ invoke: electron.invoke, on: electron.on, now: () => clock });

    const created = await renderer.createSession();
    if (!created.ok) throw new Error('no session');
    const controller = created.value;
    controller.setAnswer(QUESTION.mood, { optionId: 'op_aaaaaaaaaaaa' });
    controller.next();
    controller.setAnswer(QUESTION.detail, { value: 'It hung on save.' });

    server.offlineSubmits = 1;
    expect(await controller.submit()).toEqual({ status: 'pending' });
    expect(controller.getSnapshot().status).toBe('submitting');

    clock += 60_000;
    await main.client.flush(2_000);
    expect(controller.getSnapshot().status).toBe('submitted');
    expect(controller.getSnapshot().result?.submissionId).toMatch(/^sub_/);

    main.uninstall();
    await main.client.close(100);
  });

  it('says how to reach main when no bridge was exposed', async () => {
    const renderer = createElectronRenderer();
    await expect(renderer.getForm()).rejects.toThrow(/preload script/);
  });
});
