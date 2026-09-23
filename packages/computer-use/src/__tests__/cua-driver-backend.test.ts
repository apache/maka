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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildComputerUseTools } from '@maka/runtime/computer-use-tools';
import { createCuaDriverBackend } from '../cua-driver-backend.js';
import { CuaDriverService, type CuaDriverResult } from '../cua-driver-service.js';

test('a replaced executable cannot be spawned after the initial host check', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-cua-integrity-'));
  try {
    const path = join(directory, 'cua-driver');
    await writeFile(path, '#!/bin/sh\nexit 0\n');
    const service = new CuaDriverService(path, '0'.repeat(64));
    await assert.rejects(
      service.call('check_permissions', {}, new AbortController().signal),
      /pinned digest/,
    );
    assert.equal(service.snapshot().state, 'unavailable');
    await service.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bundle-id observation, background refusal, and explicit foreground retry pass through Maka Computer', async () => {
  let snapshot = 0;
  let unexpectedClose: (() => void) | undefined;
  const invalidated: string[] = [];
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const service = {
    snapshot: () => ({ state: 'ready' as const, generation: 1 }),
    dispose: async () => {},
    async call(name: string, args: Record<string, unknown>): Promise<CuaDriverResult> {
      calls.push({ name, args });
      if (name === 'check_permissions')
        return { content: [], structuredContent: { accessibility: true, screen_recording: true } };
      if (name === 'list_apps')
        return {
          content: [],
          structuredContent: {
            apps: [
              {
                bundle_id: 'com.example.fixture',
                name: 'Localized Fixture',
                pid: 42,
                running: true,
              },
            ],
          },
        };
      if (name === 'list_windows')
        return {
          content: [],
          structuredContent: {
            windows: [
              {
                app_name: 'Localized Fixture',
                pid: 42,
                window_id: 7,
                z_index: 1,
                bounds: { x: 10, y: 20, width: 300, height: 200 },
              },
            ],
          },
        };
      if (name === 'get_window_state') {
        snapshot += 1;
        return {
          content: [],
          structuredContent: {
            snapshot_id: `s${snapshot.toString(16).padStart(8, '0')}`,
            app_name: 'Localized Fixture',
            window_title: 'Fixture',
            elements_complete: true,
            elements: [
              {
                element_index: 0,
                element_token: `s${snapshot.toString(16).padStart(8, '0')}:0`,
                role: 'AXWindow',
                label: 'Fixture',
              },
              {
                element_index: 1,
                element_token: `s${snapshot.toString(16).padStart(8, '0')}:1`,
                role: 'AXButton',
                label: 'Submit',
                parent_index: 0,
              },
            ],
          },
        };
      }
      if (name === 'click' && args.delivery_mode === 'background') {
        return {
          isError: true,
          content: [{ type: 'text', text: 'untrusted app content' }],
          structuredContent: { code: 'background_unavailable' },
        };
      }
      if (name === 'click' && args.delivery_mode === 'foreground') {
        return { content: [], structuredContent: { route: 'accessibility', effect: 'confirmed' } };
      }
      throw new Error(`unexpected ${name}`);
    },
  } as unknown as CuaDriverService;
  const backend = createCuaDriverBackend({
    binaryPath: '/unused',
    expectedBinarySha256: '0'.repeat(64),
    createService: (_path, _digest, onClose) => {
      unexpectedClose = onClose;
      return service;
    },
    onSessionInvalidated: ({ sessionId }) => invalidated.push(sessionId),
  });
  const [tool] = buildComputerUseTools({ backend });
  const context = (toolCallId: string) => ({
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolCallId,
    cwd: '/tmp',
    abortSignal: new AbortController().signal,
    emitOutput() {},
  });
  const invoke = async (args: Record<string, unknown>, id: string): Promise<{ text: string }> =>
    (await tool!.impl(args as never, context(id))) as { text: string };

  const first = await invoke(
    { action: 'observe', app: 'com.example.fixture', include_screenshot: false },
    'observe-1',
  );
  assert.match(first.text, /com\.example\.fixture/);
  const firstObservation = /observation_id[^\n]*?([a-f0-9-]{36})/i.exec(first.text)?.[1];
  assert.ok(firstObservation);

  const refused = await invoke(
    { action: 'click_element', observation_id: firstObservation, element_id: '1' },
    'click-background',
  );
  assert.match(refused.text, /foreground_required/);
  assert.equal(calls.filter((call) => call.name === 'click').length, 1);
  assert.doesNotMatch(refused.text, /untrusted app content/);

  const refreshed = await invoke(
    { action: 'observe', app: 'com.example.fixture', include_screenshot: false },
    'observe-2',
  );
  const nextObservation = /observation_id[^\n]*?([a-f0-9-]{36})/i.exec(refreshed.text)?.[1];
  assert.ok(nextObservation);
  const foreground = await invoke(
    {
      action: 'click_element',
      observation_id: nextObservation,
      element_id: '1',
      delivery_mode: 'foreground',
    },
    'click-foreground',
  );
  assert.match(foreground.text, /confirmed|succeeded|success/i);
  assert.deepEqual(
    calls.filter((call) => call.name === 'click').map((call) => call.args.delivery_mode),
    ['background', 'foreground'],
  );
  assert.equal(
    calls
      .filter((call) => call.name === 'get_window_state')
      .every((call) => call.args.session === 'session-1'),
    true,
  );
  const beforeClose = await invoke(
    { action: 'observe', app: 'com.example.fixture', include_screenshot: false },
    'observe-before-close',
  );
  const beforeCloseObservation = /observation_id[^\n]*?([a-f0-9-]{36})/i.exec(
    beforeClose.text,
  )?.[1];
  assert.ok(beforeCloseObservation);
  unexpectedClose?.();
  assert.deepEqual(invalidated, ['session-1']);
  const afterClose = await invoke(
    { action: 'click_element', observation_id: beforeCloseObservation, element_id: '1' },
    'click-after-close',
  );
  assert.match(afterClose.text, /stale_frame|no_active_frame/);
  assert.equal(calls.filter((call) => call.name === 'click').length, 2);
  backend.dispose();
});
