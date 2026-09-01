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
import { test } from 'node:test';
import { WindowsCuLifecycleError, type WindowsCuService } from '../windows-cu-service.js';
import { createWindowsCuBackend } from '../windows-cu-backend.js';

const context = { sessionId: 's1', turnId: 't1', toolCallId: 'c1' };
const target = {
  hwnd: 101,
  pid: 42,
  processStartTimeUtc: '2026-01-01T00:00:00.0000000Z',
  windowGeneration: 'g1',
  title: 'Notepad — Notes',
};

function fakeService(
  windows = [{ hwnd: 101, pid: 42, title: 'Notepad — Notes' }],
  onRelease?: (callback: (event: any) => void) => void,
) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const service = {
    calls,
    async ensureStarted() {
      return {
        protocol: 'maka.cu.windows/0',
        generation: 1,
        capabilities: { observation: { uia: true }, capture: { targetWindowWgc: true } },
      };
    },
    subscribeRelease(callback: (event: any) => void) {
      onRelease?.(callback);
      return () => {};
    },
    async call(method: string, params: unknown) {
      calls.push({ method, params });
      if (method === 'list_windows') return { windows };
      if (method === 'observe')
        return {
          snapshotId: 'snap-1',
          target,
          tree: {
            truncated: false,
            nodes: [
              {
                token: 'tok-1',
                controlType: 'ControlType.Edit',
                name: 'Title',
                value: '',
                isEnabled: true,
                bounds: [1, 2, 100, 20],
                patterns: ['Value'],
              },
            ],
          },
        };
      if (method === 'capture')
        return { frame: { width: 2, height: 2, format: 'png', base64: 'aGVsbG8=' } };
      if (method === 'act')
        return { outcome: { status: 'verified', path: 'value_pattern', effect: 'value_set' } };
      throw new Error(`unexpected ${method}`);
    },
    snapshot() {
      return { state: 'ready' as const, generation: 1 };
    },
    clearSession() {},
    dispose() {},
  } as unknown as WindowsCuService & { calls: Array<{ method: string; params: unknown }> };
  return service;
}

test('Windows adapter keeps empty values, uses ax tier, and spends snapshots locally', async () => {
  const service = fakeService();
  const backend = createWindowsCuBackend({ binaryPath: 'unused', service });
  const observation = await backend.observeApp!(
    { windowId: 101, includeScreenshot: true },
    new AbortController().signal,
    context,
  );
  assert.equal(observation.elements[0]?.value, '');
  assert.equal(observation.elements[0]?.actions, undefined);
  assert.equal(observation.screenshot?.mimeType, 'image/png');
  const first = await backend.runSemantic!(
    {
      type: 'set_value',
      observationId: observation.observationId,
      elementId: observation.elements[0]!.elementId,
      value: 'hello',
    },
    new AbortController().signal,
    context,
  );
  assert.deepEqual(first.outcome, {
    ok: true,
    tier: 'ax',
    verified: true,
    evidence: { path: 'windows.native.value_pattern', effect: 'confirmed' },
  });
  const second = await backend.runSemantic!(
    {
      type: 'set_value',
      observationId: observation.observationId,
      elementId: observation.elements[0]!.elementId,
      value: 'again',
    },
    new AbortController().signal,
    context,
  );
  assert.equal(second.outcome.ok, false);
  if (!second.outcome.ok) assert.equal(second.outcome.error, 'stale_frame');
});

test('Windows adapter refuses ambiguous title matches', async () => {
  const service = fakeService([
    { hwnd: 101, pid: 42, title: 'Notepad — Notes' },
    { hwnd: 102, pid: 43, title: 'Notepad — Todo' },
  ]);
  const backend = createWindowsCuBackend({ binaryPath: 'unused', service });
  await assert.rejects(
    () =>
      backend.observeApp!(
        { app: 'notepad', includeScreenshot: false },
        new AbortController().signal,
        context,
      ),
    /ambiguous_target/,
  );
});

test('helper generation invalidates every observed session and composes release callbacks', async () => {
  const releaseCallbacks: Array<(event: any) => void> = [];
  const forwarded: any[] = [];
  const service = fakeService([{ hwnd: 101, pid: 42, title: 'Notepad — Notes' }], (callback) => {
    releaseCallbacks.push(callback);
  });
  const backend = createWindowsCuBackend({
    binaryPath: 'unused',
    service,
    onRelease: (event) => forwarded.push(event),
    onSessionInvalidated: (event) =>
      forwarded.push({ session: event.sessionId, unknown: event.outcomeUnknown }),
  });
  const first = await backend.observeApp!(
    { windowId: 101, includeScreenshot: false },
    new AbortController().signal,
    context,
  );
  const second = await backend.observeApp!(
    { windowId: 101, includeScreenshot: false },
    new AbortController().signal,
    { ...context, sessionId: 's2' },
  );
  assert.equal(releaseCallbacks.length, 2);
  releaseCallbacks[0]!({
    generation: 2,
    reason: 'child_exit',
    sessionIds: ['s1'],
    outcomeUnknown: true,
  });
  releaseCallbacks[1]!({
    generation: 2,
    reason: 'child_exit',
    sessionIds: ['s1'],
    outcomeUnknown: true,
  });
  assert.equal(
    (
      await backend.runSemantic!(
        {
          type: 'set_value',
          observationId: first.observationId,
          elementId: first.elements[0]!.elementId,
          value: 'x',
        },
        new AbortController().signal,
        context,
      )
    ).outcome.ok,
    false,
  );
  assert.equal(
    (
      await backend.runSemantic!(
        {
          type: 'set_value',
          observationId: second.observationId,
          elementId: second.elements[0]!.elementId,
          value: 'x',
        },
        new AbortController().signal,
        { ...context, sessionId: 's2' },
      )
    ).outcome.ok,
    false,
  );
  assert.deepEqual(
    forwarded.filter((entry) => entry.session),
    [
      { session: 's1', unknown: true },
      { session: 's2', unknown: false },
    ],
  );
  assert.equal(forwarded.filter((entry) => entry.reason === 'child_exit').length, 1);
});

test('delivered helper exit maps semantic mutation to outcome_unknown', async () => {
  const service = fakeService();
  const originalCall = service.call.bind(service);
  service.call = async (method: string, params: unknown) => {
    if (method === 'act')
      throw new WindowsCuLifecycleError('outcome_unknown', 'helper exited after delivery', 1);
    return originalCall(method, params);
  };
  const backend = createWindowsCuBackend({ binaryPath: 'unused', service });
  const observation = await backend.observeApp!(
    { windowId: 101, includeScreenshot: false },
    new AbortController().signal,
    context,
  );
  const result = await backend.runSemantic!(
    {
      type: 'set_value',
      observationId: observation.observationId,
      elementId: observation.elements[0]!.elementId,
      value: 'x',
    },
    new AbortController().signal,
    context,
  );
  assert.equal(result.outcome.ok, false);
  if (!result.outcome.ok) assert.equal(result.outcome.error, 'outcome_unknown');
});
