/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, describe, test } from 'node:test';
import { deferred, waitFor, type Deferred } from '@maka/core/test-only/async-primitives';
import type { IpcMainInvokeEvent } from 'electron';
import {
  CommandCodeBrowserLoginController,
  type CommandCodeBrowserLoginResult,
  type CommandCodeBrowserLoginStartResult,
} from '../commandcode-browser-login.js';
import {
  COMMANDCODE_LOGIN_IPC_CHANNELS,
  registerCommandCodeLoginIpc,
  type CommandCodeLoginIpcDeps,
} from '../commandcode-login-ipc-main.js';
import { IPC_SUITE_PORTS } from './commandcode-login-test-ports.js';

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

/** A renderer's WebContents: its id and the lifecycle and navigation events main observes. */
function webContents(id: number) {
  return Object.assign(new EventEmitter(), { id });
}

function eventFrom(sender: EventEmitter): IpcMainInvokeEvent {
  return { sender } as unknown as IpcMainInvokeEvent;
}

/** The listeners main holds on a renderer, by event name. */
function listeners(sender: EventEmitter): Record<string, number> {
  return Object.fromEntries(
    sender.eventNames().map((name) => [String(name), sender.listenerCount(name)]),
  );
}

type Navigation =
  | 'reload'
  | 'error-page'
  | 'refused-error-page'
  | 'same-document'
  | 'subframe'
  | 'subframe-error-page'
  | 'blocked'
  | 'cancelled';

/**
 * What Electron 43 emits on a renderer's WebContents for each navigation, as a
 * hidden BrowserWindow reported it. Only a reload, or a load of another page,
 * commits a new main-frame document, which is an error page when that load
 * fails: a hash or pushState route keeps the document, a subframe commits its
 * own, and a navigation that will-navigate prevents never commits. Neither
 * does one that is stopped, answers 204 or becomes a download, and Electron 43
 * emits nothing more for those. Only `cancelled` was not reported: it models
 * the did-fail-provisional-load Electron documents for a load that
 * window.stop() cancels, with Chromium's net::ERR_ABORTED.
 */
function navigate(sender: EventEmitter, navigation: Navigation): void {
  const isMainFrame = !navigation.startsWith('subframe');
  const isSameDocument = navigation === 'same-document';
  const url = isSameDocument ? 'file:///app/index.html#/settings' : 'file:///app/index.html';
  sender.emit(
    'did-start-navigation',
    { url, isSameDocument, isMainFrame, frame: null, initiator: null },
    url,
    isSameDocument,
    isMainFrame,
    4,
    1,
  );
  if (navigation === 'blocked') return;
  if (navigation === 'cancelled') {
    // Electron leaves out did-fail-load for an aborted load.
    sender.emit('did-fail-provisional-load', {}, -3, 'ERR_ABORTED', url, isMainFrame, 4, 1);
    return;
  }
  if (isSameDocument) {
    sender.emit('did-navigate-in-page', {}, url, isMainFrame, 4, 1);
    return;
  }
  if (navigation.endsWith('error-page')) {
    // A missing file, or a dev server that is down.
    const failure =
      navigation === 'refused-error-page'
        ? ([-102, 'ERR_CONNECTION_REFUSED', url, isMainFrame, 5, 4] as const)
        : ([-6, 'ERR_FILE_NOT_FOUND', url, isMainFrame, 5, 4] as const);
    sender.emit('did-fail-provisional-load', {}, ...failure);
    sender.emit('did-fail-load', {}, ...failure);
    return;
  }
  sender.emit('did-frame-navigate', {}, url, 200, 'OK', isMainFrame, 4, 8);
  if (isMainFrame) sender.emit('did-navigate', {}, url, 200, 'OK');
}

function harness() {
  const handlers = new Map<string, Handler>();
  const calls: unknown[][] = [];
  const sender = webContents(9);
  const controller: CommandCodeLoginIpcDeps['controller'] = {
    start: async (input, ownerId) => {
      calls.push(['start', input, ownerId]);
      return { ok: true, attemptId: 'a1', authUrl: 'https://commandcode.ai/x' };
    },
    complete: async (attemptId) => {
      calls.push(['complete', attemptId]);
      return { ok: false, reason: 'timeout' };
    },
    cancel: (attemptId) => {
      calls.push(['cancel', attemptId]);
    },
    abandonOwner: (ownerId) => {
      calls.push(['abandonOwner', ownerId]);
    },
  };
  registerCommandCodeLoginIpc({
    ipcMain: {
      handle: (channel: string, handler: Handler) => {
        handlers.set(channel, handler);
      },
    } as unknown as CommandCodeLoginIpcDeps['ipcMain'],
    controller,
  });
  const invoke = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    assert.ok(handler, `no handler for ${channel}`);
    return handler(eventFrom(sender), ...args);
  };
  return { handlers, calls, invoke, sender };
}

describe('registerCommandCodeLoginIpc', () => {
  test('registers exactly the three shared channels', () => {
    const { handlers } = harness();
    assert.deepEqual(
      [...handlers.keys()].sort(),
      Object.values(COMMANDCODE_LOGIN_IPC_CHANNELS).sort(),
    );
  });

  test('start forwards only a well-formed baseUrl', async () => {
    const { calls, invoke } = harness();
    await invoke(COMMANDCODE_LOGIN_IPC_CHANNELS.start, {
      baseUrl: 'https://staging-api.commandcode.ai/provider/v1',
    });
    await invoke(COMMANDCODE_LOGIN_IPC_CHANNELS.start, { baseUrl: 42 });
    await invoke(COMMANDCODE_LOGIN_IPC_CHANNELS.start, { baseUrl: 'x'.repeat(5_000) });
    await invoke(COMMANDCODE_LOGIN_IPC_CHANNELS.start, 'not an object');
    await invoke(COMMANDCODE_LOGIN_IPC_CHANNELS.start, undefined);
    assert.deepEqual(calls, [
      ['start', { baseUrl: 'https://staging-api.commandcode.ai/provider/v1' }, 'web-contents:9'],
      ['start', {}, 'web-contents:9'],
      ['start', {}, 'web-contents:9'],
      ['start', {}, 'web-contents:9'],
      ['start', {}, 'web-contents:9'],
    ]);
  });

  test('a renderer that goes away abandons the attempts it started, once', async () => {
    const { calls, invoke, sender } = harness();
    await invoke(COMMANDCODE_LOGIN_IPC_CHANNELS.complete, 'a1');
    await invoke(COMMANDCODE_LOGIN_IPC_CHANNELS.cancel, 'a1');
    assert.deepEqual(listeners(sender), {}, 'only a start makes the renderer an owner');

    await invoke(COMMANDCODE_LOGIN_IPC_CHANNELS.start, {});
    await invoke(COMMANDCODE_LOGIN_IPC_CHANNELS.start, {});
    assert.deepEqual(listeners(sender), {
      'render-process-gone': 1,
      destroyed: 1,
      'did-frame-navigate': 1,
      'did-fail-provisional-load': 1,
    });
    calls.splice(0);

    sender.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    sender.emit('destroyed');
    navigate(sender, 'reload');
    navigate(sender, 'error-page');
    assert.deepEqual(calls, [['abandonOwner', 'web-contents:9']]);
    assert.deepEqual(listeners(sender), {});
  });

  test('a document the renderer replaces abandons the attempts it started', async () => {
    const { calls, invoke, sender } = harness();
    await invoke(COMMANDCODE_LOGIN_IPC_CHANNELS.start, {});
    const observed = listeners(sender);
    calls.splice(0);

    navigate(sender, 'same-document');
    navigate(sender, 'subframe');
    navigate(sender, 'subframe-error-page');
    navigate(sender, 'blocked');
    navigate(sender, 'cancelled');
    assert.deepEqual(calls, [], 'the document that started the login is still there');
    assert.deepEqual(listeners(sender), observed);

    // The error boundary reloads without replacing the WebContents, and a
    // reload that fails leaves an error page. Each new document is a new owner,
    // observed once however many starts it sends.
    for (const reload of ['reload', 'error-page', 'reload', 'refused-error-page'] as const) {
      navigate(sender, reload);
      assert.deepEqual(calls.splice(0), [['abandonOwner', 'web-contents:9']]);
      assert.deepEqual(listeners(sender), {});
      await invoke(COMMANDCODE_LOGIN_IPC_CHANNELS.start, {});
      await invoke(COMMANDCODE_LOGIN_IPC_CHANNELS.start, {});
      calls.splice(0);
      assert.deepEqual(listeners(sender), observed);
    }
  });

  test('complete requires a bounded attempt id and otherwise reports superseded', async () => {
    const { calls, invoke } = harness();
    assert.deepEqual(await invoke(COMMANDCODE_LOGIN_IPC_CHANNELS.complete, 'a1'), {
      ok: false,
      reason: 'timeout',
    });
    assert.deepEqual(await invoke(COMMANDCODE_LOGIN_IPC_CHANNELS.complete, 7), {
      ok: false,
      reason: 'superseded',
    });
    assert.deepEqual(await invoke(COMMANDCODE_LOGIN_IPC_CHANNELS.complete, ''), {
      ok: false,
      reason: 'superseded',
    });
    assert.deepEqual(calls, [['complete', 'a1']]);
  });

  test('cancel needs a well-formed attempt id; anything else is ignored', async () => {
    const { calls, invoke } = harness();
    await invoke(COMMANDCODE_LOGIN_IPC_CHANNELS.cancel, undefined);
    await invoke(COMMANDCODE_LOGIN_IPC_CHANNELS.cancel, 'a1');
    await invoke(COMMANDCODE_LOGIN_IPC_CHANNELS.cancel, { attemptId: 'a1' });
    assert.deepEqual(calls, [['cancel', 'a1']]);
  });
});

// The wiring runtime-host-boot builds: the real process-scoped controller on
// real loopback ports behind the registered handlers. Only the browser and the
// renderer's WebContents are stand-ins.

const STATE = 'ipc-state-token';
const START_PORT = IPC_SUITE_PORTS.startPort;
const controllers: CommandCodeBrowserLoginController[] = [];

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
});

function wired(options: { holdBrowser?: boolean; timeoutMs?: number } = {}) {
  const handlers = new Map<string, Handler>();
  // A held browser keeps openExternal pending until the test releases it, so
  // the renderer can go away while start() is still opening the approval page.
  const opening: { readonly url: string; readonly gate: Deferred }[] = [];
  const controller = new CommandCodeBrowserLoginController({
    openExternal: (url) => {
      const gate = deferred();
      if (options.holdBrowser !== true) gate.resolve();
      opening.push({ url, gate });
      return gate.promise;
    },
    ...IPC_SUITE_PORTS,
    randomToken: () => STATE,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  controllers.push(controller);
  registerCommandCodeLoginIpc({
    ipcMain: {
      handle: (channel: string, handler: Handler) => {
        handlers.set(channel, handler);
      },
    } as unknown as CommandCodeLoginIpcDeps['ipcMain'],
    controller,
  });
  const invoke = (sender: EventEmitter, channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    assert.ok(handler, `no handler for ${channel}`);
    return handler(eventFrom(sender), ...args);
  };
  return {
    controller,
    opening,
    start: (sender: EventEmitter) =>
      invoke(sender, COMMANDCODE_LOGIN_IPC_CHANNELS.start, {}) as Promise<
        CommandCodeBrowserLoginStartResult
      >,
    complete: (sender: EventEmitter, attemptId: string) =>
      invoke(sender, COMMANDCODE_LOGIN_IPC_CHANNELS.complete, attemptId) as Promise<
        CommandCodeBrowserLoginResult
      >,
  };
}

function callbackOf(authUrl: string): URL {
  return new URL(new URL(authUrl).searchParams.get('callback') ?? '');
}

function postApproved(callback: URL) {
  return fetch(callback, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({
      apiKey: 'user_k',
      state: STATE,
      userId: 'u1',
      userName: 'joobin',
      keyName: 'k',
    }),
  });
}

/** How the document that started a login goes away. */
const DEPARTURES = [
  'render-process-gone',
  'destroyed',
  'reload',
  'error-page',
  'refused-error-page',
] as const;

function leave(renderer: EventEmitter, departure: (typeof DEPARTURES)[number]): void {
  if (departure === 'render-process-gone' || departure === 'destroyed') {
    renderer.emit(departure, {}, { reason: 'crashed', exitCode: 1 });
  } else {
    navigate(renderer, departure);
  }
}

describe('registerCommandCodeLoginIpc with the login controller', () => {
  for (const departure of DEPARTURES) {
    test(`${departure} while start() opens the browser drops the attempt and its port`, async () => {
      const { controller, opening, start } = wired({ holdBrowser: true });
      const renderer = webContents(9);
      const starting = start(renderer);
      await waitFor(() => opening.length === 1, { timeoutMs: 2_000 });
      const callback = callbackOf(opening[0]!.url);

      leave(renderer, departure);
      await assert.rejects(postApproved(callback), 'the listener goes with its document');
      assert.deepEqual(listeners(renderer), {});

      // The reply goes to a document that is gone, so nothing will complete or
      // cancel the attempt.
      opening[0]!.gate.resolve();
      await starting;
      assert.equal(controller.attemptCount(), 0);

      // Crash recovery and a reload keep the same WebContents; a destroyed one
      // is replaced.
      const recovered = departure === 'destroyed' ? webContents(10) : renderer;
      const restarting = start(recovered);
      await waitFor(() => opening.length === 2, { timeoutMs: 2_000 });
      opening[1]!.gate.resolve();
      const restarted = await restarting;
      assert.equal(restarted.ok, true, JSON.stringify(restarted));
      if (!restarted.ok) throw new Error('unreachable');
      assert.equal(Number(callbackOf(restarted.authUrl).port), START_PORT, 'the port was released');
      assert.equal(controller.attemptCount(), 1);
      assert.deepEqual(listeners(recovered), {
        'render-process-gone': 1,
        destroyed: 1,
        'did-frame-navigate': 1,
        'did-fail-provisional-load': 1,
      });
    });
  }

  for (const navigation of [
    'same-document',
    'subframe',
    'subframe-error-page',
    'blocked',
    'cancelled',
  ] as const) {
    test(`a ${navigation} navigation leaves the attempt to finish`, async () => {
      const { controller, start, complete } = wired();
      const renderer = webContents(9);
      const started = await start(renderer);
      assert.equal(started.ok, true, JSON.stringify(started));
      if (!started.ok) throw new Error('unreachable');
      const completion = complete(renderer, started.attemptId);

      navigate(renderer, navigation);
      assert.equal(controller.attemptCount(), 1);
      assert.equal((await postApproved(callbackOf(started.authUrl))).status, 200);
      assert.equal((await completion).ok, true);
      assert.equal(controller.attemptCount(), 0);
    });
  }

  test('a renderer gone while its start binds a port opens no browser and holds no port', async () => {
    const { controller, opening, start } = wired();
    const renderer = webContents(9);
    const starting = start(renderer);
    // Binding is asynchronous: the crash lands before the listener is up.
    renderer.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    assert.deepEqual(await starting, { ok: false, reason: 'superseded' });
    assert.deepEqual(opening, []);
    assert.equal(controller.attemptCount(), 0);

    const restarted = await start(renderer);
    assert.equal(restarted.ok, true, JSON.stringify(restarted));
    if (!restarted.ok) throw new Error('unreachable');
    assert.equal(Number(callbackOf(restarted.authUrl).port), START_PORT, 'the port was released');
  });

  for (const departure of DEPARTURES) {
    test(`a complete() already waiting settles as cancelled on ${departure}`, async () => {
      // A short window, so a controller that kept the attempt settles it as a
      // timeout instead of holding the suite for two minutes.
      const { controller, start, complete } = wired({ timeoutMs: 500 });
      const renderer = webContents(9);
      const started = await start(renderer);
      assert.equal(started.ok, true, JSON.stringify(started));
      if (!started.ok) throw new Error('unreachable');
      const completion = complete(renderer, started.attemptId);

      leave(renderer, departure);
      assert.deepEqual(await completion, { ok: false, reason: 'cancelled' });
      assert.equal(controller.attemptCount(), 0);
      await assert.rejects(postApproved(callbackOf(started.authUrl)));
    });
  }

  test("another renderer going away leaves this renderer's attempt to finish", async () => {
    const { controller, start, complete } = wired();
    const other = webContents(10);
    const renderer = webContents(9);
    // `other` started first, and this renderer's start superseded it.
    const earlier = await start(other);
    assert.equal(earlier.ok, true, JSON.stringify(earlier));
    if (!earlier.ok) throw new Error('unreachable');
    const superseded = complete(other, earlier.attemptId);
    const started = await start(renderer);
    assert.equal(started.ok, true, JSON.stringify(started));
    if (!started.ok) throw new Error('unreachable');
    assert.deepEqual(await superseded, { ok: false, reason: 'superseded' });
    const completion = complete(renderer, started.attemptId);

    other.emit('destroyed');
    assert.equal(controller.attemptCount(), 1);
    assert.equal((await postApproved(callbackOf(started.authUrl))).status, 200);
    assert.equal((await completion).ok, true);
    assert.equal(controller.attemptCount(), 0);
  });
});
