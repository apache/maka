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
import type { HostHandoffAction, HostHandoffView } from '@maka/runtime-host/client';
import { createDesktopHostHandoffSurface } from '../runtime-host-handoff-surface.js';
import type { DesktopHostHandoffPayload } from '../../preload/bridge-contract.js';

const attentionView = (revision: string, actions: HostHandoffAction[] = ['cancel']): HostHandoffView => ({
  revision,
  state: 'attention',
  reason: 'retry_required',
  target: { name: 'Local', location: 'local' },
  mayExitNaturally: false,
  actions,
  defaultAction: 'cancel',
});

const progressView = (revision: string): HostHandoffView => ({
  revision,
  state: 'progress',
  phase: 'staging',
  target: { name: 'Local', location: 'local' },
  mayExitNaturally: false,
  actions: ['cancel'],
  defaultAction: 'cancel',
});

function harness() {
  const sent: Array<DesktopHostHandoffPayload | null> = [];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let focuses = 0;
  const surface = createDesktopHostHandoffSurface({
    ipcMain: {
      handle(channel: string, listener: (...args: unknown[]) => unknown) {
        handlers.set(channel, listener);
      },
    } as never,
    send: (payload) => sent.push(payload),
    focus: () => {
      focuses += 1;
    },
    resolveLocale: async () => 'en',
  });
  const last = () => sent.at(-1);
  return { surface, sent, handlers, last, focuses: () => focuses };
}

test('publishes only the newest attention view; progress cannot steal the slot', async () => {
  const { surface, last } = harness();
  const first = surface(() => {});
  const second = surface(() => {});

  first.update(attentionView('r1'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(last()?.view.revision, 'r1');

  // A concurrent handoff's progress update must not displace the decision.
  second.update(progressView('r2'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(last()?.view.revision, 'r1');

  // An attention update from the second handoff claims the slot.
  second.update(attentionView('r2'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(last()?.view.revision, 'r2');

  // The active handoff transitioning to progress falls back to the other
  // pending decision instead of going silent.
  second.update(progressView('r2'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(last()?.view.revision, 'r1');

  first.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(last(), null);
});

test('raises the window once per attention revision, never for progress', async () => {
  const { surface, focuses } = harness();
  const handoff = surface(() => {});

  handoff.update(progressView('p1'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(focuses(), 0);

  handoff.update(attentionView('a1'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(focuses(), 1);

  // Repeats of the decision already on screen do not steal focus again.
  handoff.update(attentionView('a1'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(focuses(), 1);

  handoff.update(attentionView('a2'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(focuses(), 2);
});

test('a publication superseded by close cannot resurrect the stale view', async () => {
  const pending: Array<() => void> = [];
  const sent: Array<DesktopHostHandoffPayload | null> = [];
  const surface = createDesktopHostHandoffSurface({
    ipcMain: { handle() {} } as never,
    send: (payload) => sent.push(payload),
    focus: () => {},
    resolveLocale: () =>
      new Promise((resolve) => pending.push(() => resolve('en' as const))),
  });
  const handoff = surface(() => {});

  handoff.update(attentionView('a1'));
  handoff.close();
  // The newer close publishes first; the older attention payload resolves
  // afterwards and must be dropped instead of resurrecting the modal.
  pending[1]?.();
  await new Promise((resolve) => setImmediate(resolve));
  pending[0]?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, [null]);
});

test('decide routes only a live attention revision and advertised action', async () => {
  const { surface, handlers } = harness();
  const decisions: Array<[string, HostHandoffAction]> = [];
  const handoff = surface((revision, action) => decisions.push([revision, action]));
  handoff.update(attentionView('live', ['cancel', 'retry']));
  const decide = handlers.get('runtime-host-handoff:decide');
  assert.ok(decide);

  decide({}, { revision: 'live', action: 'retry' });
  assert.deepEqual(decisions, [['live', 'retry']]);

  // A stale revision, a non-advertised action, and a progress view all miss.
  decide({}, { revision: 'stale', action: 'cancel' });
  decide({}, { revision: 'live', action: 'replace' });
  handoff.update(progressView('live'));
  decide({}, { revision: 'live', action: 'cancel' });
  assert.deepEqual(decisions, [['live', 'retry']]);
});
