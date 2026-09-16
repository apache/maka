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
import { afterEach, test } from 'node:test';
import { act, createElement, StrictMode } from 'react';
import type { NavSelection } from '@maka/ui';
import type { TaskEntryShellProjection } from '../../renderer/features/task-entry/testing.js';
import { useComputerHistoryDraft } from '../../renderer/features/module-hub/testing.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

afterEach(cleanupFakeDom);

function harness({ remote = false, session = true, strict = false } = {}) {
  const { root } = installReactRenderer();
  let selected: NavSelection = { section: 'computer-history' };
  let revision = 0;
  let text = 'Existing draft';
  let focuses = 0;
  let appends = 0;
  let starts = 0;
  const errors: unknown[] = [];
  const localTarget = { profileId: 'local', hostId: 'local-host', projectId: 'project' };
  const remoteTarget = { profileId: 'remote', hostId: 'remote-host', projectId: 'remote-project' };
  const taskEntry: TaskEntryShellProjection = {
    commands: {
      refresh: async () => undefined,
      selectLocalProject: () => false,
      selectLocalTarget: () => localTarget,
      addProject: () => undefined,
      chooseProjectForProfile: async () => undefined,
      resolveWorkBoardTarget: () => { throw new Error('History must not resolve a Work Board target'); },
      prepareWorkBoardDraft: () => { throw new Error('History must not prepare a Work Board draft'); },
    },
    selectors: {
      target: remote ? remoteTarget : localTarget,
      selectedHost: {
        ...(remote ? remoteTarget : localTarget),
        name: remote ? 'Remote' : 'Local',
        kind: remote ? 'remote' : 'local',
        chatDefaults: { permissionMode: 'ask', thinkingLevel: 'high' },
      },
      draftKey: remote ? 'remote-draft' : 'local-draft',
      defaultProfileId: remote ? 'remote' : 'local',
      usesDefaultHost: true,
      canAddProject: true,
    },
  };
  let input: Parameters<typeof useComputerHistoryDraft>[0] = {
    selection: selected,
    activeSessionId: session ? (remote ? 'remote-session' : 'local-session') : undefined,
    activeSessionIsLocal: !remote,
    switchingSession: false,
    obscured: false,
    target: taskEntry.selectors.target,
    targetIsLocal: !remote,
    draftKey: taskEntry.selectors.draftKey,
    selectLocalTarget: taskEntry.commands.selectLocalTarget,
    composer: {
      current: {
        appendText(next) { text += `\n\n${next}`; appends += 1; },
        focus() { focuses += 1; },
      },
    },
    captureSelection: () => {
      const current = revision;
      return () => current === revision;
    },
    selectChat: (selection) => { selected = selection; },
    startNewSession: () => { starts += 1; revision += 1; },
    reportError: (error) => { errors.push(error); },
  };
  let createDraft!: (text: string) => void;
  function Probe() {
    createDraft = useComputerHistoryDraft(input);
    return null;
  }
  const render = () => root.render(strict
    ? createElement(StrictMode, null, createElement(Probe))
    : createElement(Probe));
  return {
    root, render, taskEntry, localTarget, errors,
    create: (next = 'History context') => createDraft(next),
    commit(patch: Partial<typeof input> = {}) {
      input = { ...input, selection: selected, ...patch };
      render();
    },
    revokeSessionSelection: () => { revision += 1; },
    result: () => ({ text, focuses, appends, starts, selected }),
  };
}

test('history appends once to the committed local Composer and preserves its draft', async () => {
  const h = harness({ strict: true });
  await act(async () => h.render());
  await act(async () => { h.create(); h.create(); });
  assert.equal(h.result().appends, 0);
  await act(async () => h.commit());
  assert.deepEqual(h.result(), {
    text: 'Existing draft\n\nHistory context',
    focuses: 1,
    appends: 1,
    starts: 0,
    selected: { section: 'sessions' },
  });
  await act(async () => h.commit());
  assert.equal(h.result().appends, 1);
});

test('history selects a local new-task target without appending to a remote Composer', async () => {
  const h = harness({ remote: true });
  await act(async () => h.render());
  await act(async () => h.create());
  await act(async () => h.commit({ activeSessionId: undefined }));
  assert.equal(h.result().appends, 0);
  await act(async () => h.commit({
    target: h.localTarget,
    draftKey: 'local-draft',
    targetIsLocal: true,
  }));
  assert.equal(h.result().appends, 1);
  assert.equal(h.result().starts, 1);
  assert.equal(h.result().text, 'Existing draft\n\nHistory context');
});

test('history can append to a local empty-session draft without creating a Session', async () => {
  const h = harness({ session: false });
  await act(async () => h.render());
  await act(async () => h.create());
  await act(async () => h.commit());
  assert.equal(h.result().starts, 0);
  assert.equal(h.result().appends, 1);
});

for (const reason of ['navigation', 'session', 'target', 'composer', 'obscured', 'unmount'] as const) {
  test(`history abandons the pending append after ${reason} changes`, async () => {
    const h = harness({ session: false });
    await act(async () => h.render());
    await act(async () => h.create());
    await act(async () => {
      if (reason === 'unmount') {
        h.root.unmount();
      } else if (reason === 'navigation') {
        h.commit({ selection: { section: 'extensions', module: 'skills' } });
      } else if (reason === 'session') {
        h.revokeSessionSelection();
        h.commit();
      } else if (reason === 'target') {
        h.commit({
          draftKey: 'different-draft',
        });
      } else if (reason === 'composer') {
        h.commit({ composer: { current: { appendText() { assert.fail('Replaced Composer'); }, focus() {} } } });
      } else {
        h.commit({ obscured: true });
      }
    });
    assert.equal(h.result().appends, 0);
    assert.equal(h.result().focuses, 0);
    assert.deepEqual(h.errors, []);
  });
}

test('an unavailable local destination reports failure without changing navigation or draft', async () => {
  const h = harness({ remote: true });
  await act(async () => h.render());
  await act(async () => h.commit({
    selection: { section: 'computer-history' },
    selectLocalTarget: () => undefined,
  }));
  await act(async () => h.create());
  assert.equal(h.errors.length, 1);
  assert.equal(h.result().appends, 0);
  assert.equal(h.result().starts, 0);
  assert.deepEqual(h.result().selected, { section: 'computer-history' });
});
