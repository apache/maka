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

import test from 'node:test';
import assert from 'node:assert/strict';
import { ASSISTANT_BACKGROUND_SESSION_LABEL } from '@maka/core/session';
import { createDefaultSettings, normalizeSettings, mergeSettings } from '@maka/core/settings';
import { createAssistantSessionVisibility } from '../../renderer/application/contracts/session-catalog/assistant-session-visibility.js';
import { sessionMatchesRail, selectPaletteSessions } from '../../renderer/application/contracts/session-catalog/session-rail-visibility.js';
import { clientOwnedSettingsPatch, hasRuntimeHostSettingsPatch, projectClientOwnedSettings } from '../../shared/settings-ownership.js';
import { deriveSessionRail } from '../../renderer/features/session-navigation/testing.js';

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
test('assistant worker visibility defaults off, persists and belongs to this Desktop', () => {
  const defaults = createDefaultSettings();
  assert.equal(defaults.appearance.showAssistantBackgroundSessions, false);
  assert.equal(normalizeSettings({}).appearance.showAssistantBackgroundSessions, false);
  assert.equal(normalizeSettings({ appearance: { showAssistantBackgroundSessions: 'true' } }).appearance.showAssistantBackgroundSessions, false);
  const patch = { appearance: { showAssistantBackgroundSessions: true } };
  const saved = normalizeSettings(mergeSettings(defaults, patch));
  assert.equal(saved.appearance.showAssistantBackgroundSessions, true);
  assert.deepEqual(clientOwnedSettingsPatch(patch), patch);
  assert.equal(hasRuntimeHostSettingsPatch(patch), false);
  assert.equal(projectClientOwnedSettings(defaults, saved).appearance.showAssistantBackgroundSessions, true);
});

test('rail and palette agree; ordinary, WorkHub and unrelated agents are not classified by their name', () => {
  const sessions: any[] = [
    { id: 'ordinary', name: 'Memory: user named conversation', labels: [] },
    { id: 'worker', labels: [ASSISTANT_BACKGROUND_SESSION_LABEL] },
    { id: 'assistant', labels: ['personal-assistant'] },
    { id: 'workhub', labels: ['workhub'] },
    { id: 'other-agent', labels: ['some-plugin-worker'] },
    { id: 'archived', labels: [ASSISTANT_BACKGROUND_SESSION_LABEL], isArchived: true },
  ];
  const state = { sessions } as any;
  assert.deepEqual(selectPaletteSessions(state, new Set()).map(s => s.id), ['ordinary', 'workhub', 'other-agent']);
  assert.deepEqual(selectPaletteSessions(state, new Set(), undefined, true).map(s => s.id), ['ordinary', 'worker', 'workhub', 'other-agent']);
  assert.equal(sessionMatchesRail(sessions[1], undefined, true), true);
  assert.equal(sessionMatchesRail(sessions[2], undefined, true), false);
  // The catalog retains an open worker; visibility only changes navigation membership.
  assert.equal(deriveSessionRail(sessions, 'worker', s => sessionMatchesRail(s)).sessions.some(s => s.id === 'worker'), false);
  assert.equal(state.sessions.some((s: any) => s.id === 'worker'), true);
});

test('preference updates all subscribers, reloads on restart, and failed writes preserve the previous value', async () => {
  let saved = false;
  let fail = false;
  let changed = () => {};
  const source = {
    read: async () => saved,
    write: async (value: boolean) => { if (fail) throw Error('disk unavailable'); saved = value; },
    subscribeChanges: (listener: () => void) => { changed = listener; return () => {}; },
  };
  const store = createAssistantSessionVisibility(source);
  let updates = 0;
  const stop = store.subscribe(() => updates++);
  const stopOther = store.subscribe(() => updates++);
  await turn();
  await store.setVisible(true);
  assert.equal(store.getSnapshot(), true);
  assert.equal(updates, 2);
  fail = true;
  await assert.rejects(store.setVisible(false), /disk unavailable/);
  assert.equal(store.getSnapshot(), true);
  stop(); stopOther();
  const restarted = createAssistantSessionVisibility(source);
  const stopRestarted = restarted.subscribe(() => {});
  await turn();
  assert.equal(restarted.getSnapshot(), true);
  saved = false; changed();
  await turn();
  assert.equal(restarted.getSnapshot(), false);
  stopRestarted();
});

test('an old settings read cannot overwrite a newer user choice', async () => {
  let resolve!: (value: boolean) => void;
  const store = createAssistantSessionVisibility({
    read: () => new Promise<boolean>(r => { resolve = r; }),
    write: async () => {},
    subscribeChanges: () => () => {},
  });
  const stop = store.subscribe(() => {});
  await store.setVisible(true);
  resolve(false);
  await turn();
  assert.equal(store.getSnapshot(), true);
  stop();
});
