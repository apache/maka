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
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildComputerUseTools } from '@maka/runtime/computer-use-tools';
import { Client } from '@modelcontextprotocol/client';
import { createCuaDriverBackend } from '../cua-driver-backend.js';
import { CuaDriverService, type CuaDriverResult } from '../cua-driver-service.js';

test('a hung request retires its child before a concurrent observation restarts it, without replay', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-cua-timeout-'));
  const path = join(directory, 'cua-driver');
  const log = join(directory, 'calls');
  const source = `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const log = ${JSON.stringify(log)};
const recovered = fs.existsSync(log);
fs.appendFileSync(log, process.pid + '\\n');
if (!recovered) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 10000);
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
      protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },
      serverInfo: { name: 'qualification-fixture', version: '1' }
    } }));
  } else if (request.method === 'tools/call') {
    fs.appendFileSync(log, request.params.name + '\\n');
    if (recovered) console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id,
      result: { content: [], structuredContent: { recovered: true } } }));
  }
});
`;
  const original = Client.prototype.callTool;
  t.mock.method(
    Client.prototype,
    'callTool',
    function (
      this: Client,
      params: Parameters<Client['callTool']>[0],
      options: Parameters<Client['callTool']>[1],
    ) {
      return original.call(this, params, { ...options, timeout: 250 });
    },
  );
  let invalidations = 0;
  let notifyInvalidated!: () => void;
  const invalidated = new Promise<void>((resolve) => {
    notifyInvalidated = resolve;
  });
  const service = new CuaDriverService(
    path,
    createHash('sha256').update(source).digest('hex'),
    () => {
      invalidations += 1;
      notifyInvalidated();
    },
  );
  let timedOut: Promise<void> | undefined;
  try {
    await writeFile(path, source, { mode: 0o755 });
    const signal = new AbortController().signal;
    timedOut = assert.rejects(service.call('type_text', { text: 'once' }, signal), /timed out/i);
    await Promise.race([
      invalidated,
      timedOut.then(() => {
        throw new Error('Missing executor invalidation');
      }),
    ]);
    assert.equal(service.snapshot().state, 'unavailable');
    assert.equal(invalidations, 1);
    const retired = service.snapshot().generation;
    const result = await service.call('get_window_state', {}, signal);
    const lines = (await readFile(log, 'utf8')).trim().split('\n');
    assert.throws(() => process.kill(Number(lines[0]), 0), /ESRCH/);
    await timedOut;
    assert.equal(result.structuredContent?.recovered, true);
    assert.ok(service.snapshot().generation > retired);
    assert.deepEqual(
      lines.filter((line) => !/^\d+$/.test(line)),
      ['type_text', 'get_window_state'],
    );
  } finally {
    await timedOut?.catch(() => {});
    await service.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

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
  const values = { observed: '', current: '' };
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
              {
                element_index: 2,
                element_token: `s${snapshot.toString(16).padStart(8, '0')}:2`,
                role: 'AXTextField',
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
          structuredContent: { code: 'same_pid_keyboard_ambiguity' },
        };
      }
      if (name === 'click' && args.delivery_mode === 'foreground') {
        return { content: [], structuredContent: { route: 'accessibility', effect: 'confirmed' } };
      }
      if (name === 'type_text' || name === 'press_key') {
        const target = String(args.element_token).endsWith(':2') ? 'observed' : 'current';
        values[target] += String(args.text ?? args.key);
        return { content: [], structuredContent: { route: 'accessibility', effect: 'confirmed' } };
      }
      if (name === 'hotkey') return { content: [], structuredContent: { effect: 'unverifiable' } };
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
    permissionMode: 'bypass' as const,
    requestUserForm: async () => {
      throw new Error('Computer Use must not add approval after Host admission');
    },
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

  const inputObservation = async (id: string) => {
    const result = await invoke(
      { action: 'observe', app: 'com.example.fixture', include_screenshot: false },
      id,
    );
    const observationId = /observation_id[^\n]*?([a-f0-9-]{36})/i.exec(result.text)?.[1];
    assert.ok(observationId);
    return observationId;
  };
  await invoke(
    {
      action: 'type',
      observation_id: await inputObservation('observe-type'),
      element_id: '2',
      text: 'PRIVATE',
    },
    'type-after-focus-moved',
  );
  await invoke(
    {
      action: 'press_key',
      observation_id: await inputObservation('observe-key'),
      element_id: '2',
      text: 'Backspace',
    },
    'key-after-focus-moved',
  );
  assert.deepEqual(values, { observed: 'PRIVATEBackspace', current: '' });
  const noFocus = await inputObservation('observe-without-focus');
  const inputCalls = calls.filter((call) => call.name === 'type_text').length;
  const unbound = await invoke(
    { action: 'type', observation_id: noFocus, text: 'unbound' },
    'type-without-focus',
  );
  assert.match(unbound.text, /dispatch_refused/);
  assert.equal(calls.filter((call) => call.name === 'type_text').length, inputCalls);
  await invoke(
    { action: 'key', observation_id: await inputObservation('observe-hotkey'), text: 'cmd+s' },
    'window-hotkey',
  );
  assert.equal(calls.filter((call) => call.name === 'hotkey').length, 1);
  backend.dispose();
});

test('observations list menu titles, open one named menu, and refuse a token from a replaced page', async () => {
  const clicks: Array<Record<string, unknown>> = [];
  const menuActions = ['AXPress', 'AXPick', 'AXCancel'];
  const service = {
    snapshot: () => ({ state: 'ready' as const, generation: 1 }),
    dispose: async () => {},
    async call(name: string, args: Record<string, unknown>): Promise<CuaDriverResult> {
      if (name === 'list_apps')
        return {
          content: [],
          structuredContent: {
            apps: [{ bundle_id: 'com.apple.TextEdit', name: 'TextEdit', pid: 42 }],
          },
        };
      if (name === 'list_windows')
        return {
          content: [],
          structuredContent: { windows: [{ app_name: 'TextEdit', pid: 42, window_id: 7 }] },
        };
      if (name === 'get_window_state')
        return {
          content: [],
          structuredContent: {
            snapshot_id: 's00000001',
            elements: [
              [0, 'AXWindow', 'Untitled'],
              [1, 'AXTextArea', 'Body', 0],
              [2, 'AXMenuBar', undefined],
              [3, 'AXMenuBarItem', 'File', 2],
              [4, 'AXMenu', undefined, 3],
              [5, 'AXMenuItem', 'Save', 4],
              [6, 'AXMenuBarItem', 'Edit', 2],
              [7, 'AXMenu', undefined, 6],
              [8, 'AXMenuItem', 'Copy', 7],
            ].map(([index, role, label, parent]) => ({
              element_index: index,
              element_token: `s00000001:${index}`,
              role,
              ...(label ? { label } : {}),
              ...(parent === undefined ? {} : { parent_index: parent }),
              ...(String(role).startsWith('AXMenu') ? { actions: menuActions } : {}),
            })),
          },
        };
      if (name === 'click') {
        clicks.push(args);
        return {
          isError: true,
          content: [],
          structuredContent: { code: 'element_outside_target_window', effect: 'refused' },
        };
      }
      throw new Error(`unexpected ${name}`);
    },
  } as unknown as CuaDriverService;
  const backend = createCuaDriverBackend({
    binaryPath: '/unused',
    expectedBinarySha256: '0'.repeat(64),
    createService: () => service,
  });
  const context = {
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolCallId: 'call-1',
    boundAction: { target: { pid: 42, windowId: 7 } } as never,
  };
  const signal = new AbortController().signal;
  const ids = (observation: { elements: Array<{ elementId: string }> }) =>
    observation.elements.map((element) => element.elementId);

  const bar = await backend.observeApp!(
    { app: 'com.apple.TextEdit', includeScreenshot: false },
    signal,
    context,
  );
  assert.deepEqual(ids(bar), ['0', '1', '2', '3', '6']);
  assert.equal(bar.menu, undefined);
  assert.deepEqual(bar.elements.find((element) => element.elementId === '3')?.actions, []);
  assert.equal(
    (
      await backend.runSemantic!(
        { type: 'click_element', observationId: bar.observationId, elementId: '5' },
        signal,
        context,
      )
    ).outcome.ok,
    false,
  );
  assert.equal(clicks.length, 0);

  const file = await backend.observeApp!(
    { app: 'com.apple.TextEdit', includeScreenshot: false, menu: 'file' },
    signal,
    context,
  );
  assert.deepEqual(ids(file), ['0', '1', '2', '3', '4', '5', '6']);
  assert.deepEqual(file.menu, { opened: 'File' });

  const replaced = await backend.runSemantic!(
    { type: 'click_element', observationId: file.observationId, elementId: '5' },
    signal,
    context,
  );
  assert.equal(clicks[0]?.element_token, 's00000001:5');
  assert.deepEqual(
    replaced.outcome.ok ? undefined : [replaced.outcome.error, replaced.outcome.evidence],
    ['stale_frame', { path: 'none' }],
  );
  backend.dispose();
});
