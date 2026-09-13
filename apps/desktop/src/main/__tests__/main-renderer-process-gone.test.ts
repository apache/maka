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
import { test } from 'node:test';
import type { RenderProcessGoneDetails } from 'electron';
import {
  type MainRendererFrameIdentity,
  observeMainRendererProcessGone,
  reloadMainRendererProcess,
} from '../main-renderer-process-gone.js';

test('observes one unexpected main Renderer exit while the app is running', () => {
  const source = new EventEmitter();
  const observed: RenderProcessGoneDetails[] = [];
  observeMainRendererProcessGone({
    source,
    shutdownSignal: new AbortController().signal,
    onUnexpectedExit: (details) => observed.push(details),
  });

  source.emit('render-process-gone', {}, { reason: 'oom', exitCode: 137 });
  source.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 11 });

  assert.deepEqual(observed, [{ reason: 'oom', exitCode: 137 }]);
});

test('ignores clean exits and app shutdown', () => {
  for (const scenario of [
    { aborted: false, details: { reason: 'clean-exit', exitCode: 0 } as const },
    { aborted: true, details: { reason: 'killed', exitCode: 9 } as const },
  ]) {
    const source = new EventEmitter();
    const abort = new AbortController();
    let observed = false;
    observeMainRendererProcessGone({
      source,
      shutdownSignal: abort.signal,
      onUnexpectedExit: () => {
        observed = true;
      },
    });
    if (scenario.aborted) abort.abort();

    source.emit('render-process-gone', {}, scenario.details);
    assert.equal(observed, false);
  }
});

test('accepts first-paint readiness only from the frame committed by this reload', async () => {
  const source = reloadSource();
  const readiness = rendererReadiness();
  const previousFrame = frameIdentity(1, 'previous');
  const currentFrame = frameIdentity(2, 'current');
  let observed = false;
  const result = reloadMainRendererProcess({
    source,
    shutdownSignal: new AbortController().signal,
    subscribeMainFrameCommitted: readiness.subscribeCommit,
    subscribeRendererReady: readiness.subscribe,
    onReady: () => {
      observed = true;
    },
  });

  assert.equal(source.reloadCalls, 1);
  source.emit('did-fail-load', {}, -3, 'subframe failed', 'https://example.test/frame', false, 1, 2);
  assert.equal(readiness.notify(previousFrame), false);
  readiness.commit(currentFrame);
  assert.equal(readiness.notify(previousFrame), false);
  assert.equal(observed, false);
  assert.equal(readiness.notify(currentFrame), true);
  assert.equal(await result, true);
  assert.equal(observed, true);
  assert.equal(source.listenerCount('did-fail-load'), 0);
  assert.equal(source.listenerCount('render-process-gone'), 0);
  assert.equal(readiness.subscribed(), false);
});

test('keeps recovery active when a Renderer reload fails, exits, or stops responding', async () => {
  for (const fail of [
    (source: ReturnType<typeof reloadSource>) =>
      source.emit('did-fail-load', {}, -105, 'name not resolved', 'https://bad.test', true, 1, 2),
    (source: ReturnType<typeof reloadSource>) =>
      source.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 11 }),
    (source: ReturnType<typeof reloadSource>) => source.emit('unresponsive'),
  ]) {
    const source = reloadSource();
    const readiness = rendererReadiness();
    let observed = false;
    const result = reloadMainRendererProcess({
      source,
      shutdownSignal: new AbortController().signal,
      subscribeMainFrameCommitted: readiness.subscribeCommit,
      subscribeRendererReady: readiness.subscribe,
      onReady: () => {
        observed = true;
      },
    });

    fail(source);
    assert.equal(await result, false);
    assert.equal(observed, false);
    assert.equal(source.listenerCount('unresponsive'), 0);
    assert.equal(readiness.subscribed(), false);
  }
});

test('bounds a Renderer reload that emits no terminal event', async () => {
  const source = reloadSource();
  const readiness = rendererReadiness();
  const result = reloadMainRendererProcess({
    source,
    shutdownSignal: new AbortController().signal,
    subscribeMainFrameCommitted: readiness.subscribeCommit,
    subscribeRendererReady: readiness.subscribe,
    onReady: () => assert.fail('timed-out reload must not report success'),
    timeoutMs: 1,
  });

  assert.equal(await result, false);
  assert.equal(source.listenerCount('did-fail-load'), 0);
  assert.equal(source.listenerCount('unresponsive'), 0);
  assert.equal(source.listenerCount('render-process-gone'), 0);
  assert.equal(readiness.subscribed(), false);
});

function rendererReadiness(): {
  subscribe(listener: (frame: MainRendererFrameIdentity) => boolean): () => void;
  subscribeCommit(listener: (frame: MainRendererFrameIdentity) => void): () => void;
  notify(frame: MainRendererFrameIdentity): boolean;
  commit(frame: MainRendererFrameIdentity): void;
  subscribed(): boolean;
} {
  let listener: ((frame: MainRendererFrameIdentity) => boolean) | undefined;
  let commitListener: ((frame: MainRendererFrameIdentity) => void) | undefined;
  return {
    subscribe(next) {
      listener = next;
      return () => {
        if (listener === next) listener = undefined;
      };
    },
    subscribeCommit(next) {
      commitListener = next;
      return () => {
        if (commitListener === next) commitListener = undefined;
      };
    },
    notify(frame) {
      return listener?.(frame) ?? false;
    },
    commit(frame) {
      commitListener?.(frame);
    },
    subscribed() {
      return listener !== undefined || commitListener !== undefined;
    },
  };
}

function frameIdentity(processId: number, frameToken: string): MainRendererFrameIdentity {
  return { processId, frameToken };
}

function reloadSource(): EventEmitter & {
  reloadCalls: number;
  reload(): void;
  isDestroyed(): boolean;
} {
  return Object.assign(new EventEmitter(), {
    reloadCalls: 0,
    reload() {
      this.reloadCalls += 1;
    },
    isDestroyed() {
      return false;
    },
  });
}
