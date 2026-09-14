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
import type { IpcMainInvokeEvent } from 'electron';
import { registerExternalAgentSetupIpc } from '../external-agent-setup-ipc-main.js';
import { RuntimeHostOAuthPresentation } from '../runtime-host-oauth-presentation.js';
import type { ExternalAgentSetupProjection } from '@maka/runtime-host/protocol';

test('external setup shares browser presentation without accepting a stale attempt URL', async () => {
  const opened: string[] = [];
  const presentation = new RuntimeHostOAuthPresentation(async (url) => {
    opened.push(url);
  });
  const pending = presentation.expect('new-attempt', 'new-attempt');
  await assert.rejects(
    presentation.openExternal(
      'https://accounts.google.com/old',
      'old-attempt',
      new AbortController().signal,
    ),
  );
  assert.deepEqual(opened, []);
  await presentation.openExternal(
    'https://accounts.google.com/new',
    'new-attempt',
    new AbortController().signal,
  );
  assert.deepEqual(await pending.presented, { stateHint: 'new-attempt' });
  assert.deepEqual(opened, ['https://accounts.google.com/new']);
});
test('setup IPC registers an expectation before start and releases it on terminal result or cancel', async () => {
  type Handler = Parameters<
    Parameters<typeof registerExternalAgentSetupIpc>[0]['ipcMain']['handle']
  >[1];
  const handlers = new Map<string, Handler>();
  const opened: string[] = [];
  const presentation = new RuntimeHostOAuthPresentation(async (url) => {
    opened.push(url);
  });
  let phase: ExternalAgentSetupProjection['phase'] = 'connecting';
  let attempts = 0;
  const input = { attemptId: 'attempt-1', action: 'login' as const, expectedExecutable: '/agent' };
  registerExternalAgentSetupIpc({
    selectExecutable: async () => "/existing/agy_acp_server.par",
    ipcMain: {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    presentation,
    client: {
      startExternalAgentSetup: async (value) => {
        attempts++;
        await presentation.openExternal(
          'https://accounts.google.com/test',
          value.attemptId,
          new AbortController().signal,
        );
        return { ...value, phase };
      },
      queryExternalAgentSetup: async () => ({ ...input, phase }),
      cancelExternalAgentSetup: async () => ({ ...input, phase: 'cancelled' }),
    },
  });
  const invoke = (channel: string, input: unknown) =>
    handlers.get(channel)!({} as IpcMainInvokeEvent, input);
  assert.equal(await invoke('external-agents:select-executable', undefined), '/existing/agy_acp_server.par');
  assert.deepEqual(opened, []);
  await invoke('external-agents:setup:start', input);
  assert.equal(attempts, 1);
  assert.equal(opened.length, 1);
  // A query after presentation must not recreate a setup slot or interfere
  // with a regular model OAuth expectation.
  const concurrent = presentation.expect('model-after-presentation');
  await invoke('external-agents:setup:query', { attemptId: input.attemptId });
  concurrent.cancel();
  phase = 'succeeded';
  await invoke('external-agents:setup:query', { attemptId: input.attemptId });
  await invoke('external-agents:setup:start', { ...input, attemptId: 'attempt-2' });
  await invoke('external-agents:setup:cancel', { attemptId: 'attempt-2' });
  const next = presentation.expect('regular-oauth');
  next.cancel();
});

test('setup accepts a delayed authorization link and clears terminal, cancelled and abandoned expectations', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  type Handler = Parameters<Parameters<typeof registerExternalAgentSetupIpc>[0]['ipcMain']['handle']>[1];
  const handlers = new Map<string, Handler>();
  const opened: string[] = [];
  const presentation = new RuntimeHostOAuthPresentation(async (url) => { opened.push(url); });
  let input = { attemptId: 'slow-login', action: 'login' as const, expectedExecutable: '/agent' };
  let phase: ExternalAgentSetupProjection['phase'] = 'connecting';
  registerExternalAgentSetupIpc({
    ipcMain: { handle: (channel, listener) => { handlers.set(channel, listener); } },
    presentation,
    client: {
      startExternalAgentSetup: async (value) => ({ ...value, phase }),
      queryExternalAgentSetup: async () => ({ ...input, phase }),
      cancelExternalAgentSetup: async () => ({ ...input, phase: 'cancelled' }),
    },
  });
  const invoke = (channel: string) => handlers.get(channel)!({} as IpcMainInvokeEvent,
    channel === 'external-agents:setup:start' ? input : { attemptId: input.attemptId });
  const present = () => presentation.openExternal('https://accounts.google.com/delayed', input.attemptId, new AbortController().signal);
  await invoke('external-agents:setup:start');
  // Active renderer polling keeps the presentation lease alive while the Host
  // initializes and waits for authentication.
  for (let elapsed = 0; elapsed < 320_000; elapsed += 20_000) {
    t.mock.timers.tick(20_000);
    await invoke('external-agents:setup:query');
  }
  await present();
  assert.equal(opened.length, 1);
  const concurrent = presentation.expect('model-after-presentation');
  await invoke('external-agents:setup:query');
  concurrent.cancel();
  phase = 'succeeded';
  await invoke('external-agents:setup:query');
  for (const terminal of ['failed', 'cancelled'] as const) {
    input = { ...input, attemptId: terminal };
    phase = 'connecting';
    await invoke('external-agents:setup:start');
    t.mock.timers.tick(20_000);
    if (terminal === 'cancelled') await invoke('external-agents:setup:cancel');
    else { phase = 'failed'; await invoke('external-agents:setup:query'); }
    await assert.rejects(present(), /no matching OAuth presentation/);
  }
  input = { ...input, attemptId: 'abandoned' };
  phase = 'connecting';
  await invoke('external-agents:setup:start');
  t.mock.timers.tick(20_000);
  await handlers.get('external-agents:setup:query')!(
    {} as IpcMainInvokeEvent,
    { attemptId: 'unrelated-attempt' },
  );
  t.mock.timers.tick(10_000);
  await assert.rejects(present(), /no matching OAuth presentation/);
  // A late query for the expired setup cannot renew or cancel a newer slot;
  // state binding also prevents the stale setup URL from consuming it.
  const next = presentation.expect('next-model', 'next-model');
  await invoke('external-agents:setup:query');
  await assert.rejects(present(), /belongs to another attempt/);
  await invoke('external-agents:setup:cancel');
  await presentation.openExternal(
    'https://accounts.google.com/next',
    'next-model',
    new AbortController().signal,
  );
  assert.deepEqual(await next.presented, { stateHint: 'next-model' });
  input = { ...input, attemptId: 'next-setup' };
  await invoke('external-agents:setup:start');
  t.mock.timers.tick(30_000);
  await Promise.resolve();
  input = { ...input, attemptId: 'setup-after-abandonment' };
  await invoke('external-agents:setup:start');
  await invoke('external-agents:setup:cancel');
  const regular = presentation.expect('regular-oauth');
  t.mock.timers.tick(30_000);
  await assert.rejects(regular.presented, /did not present OAuth authorization/);
  assert.equal(opened.length, 2);
});
