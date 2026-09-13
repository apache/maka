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
import type { NavSelection } from '@maka/ui';
import {
  captureActiveComposerClaim,
  createComposerSurfaceAuthority,
} from '../../renderer/shell/composer-surface.js';
import {
  hasWorkspaceActions,
  resolveShellDetailView,
} from '../../renderer/shell/detail-view.js';

test('Composer owners require the captured navigation, Session selection and new-task target', () => {
  const activeIdRef: { current: string | undefined } = { current: 'session-a' };
  const navSelectionRef: { current: NavSelection } = { current: { section: 'sessions' } };
  let selectedId = activeIdRef.current;
  const input = {
    activeIdRef,
    navSelectionRef,
    isSessionSelected: (id: string | undefined) => id === selectedId,
    newTaskDraftKey: 'local/project-a',
  };
  const authority = createComposerSurfaceAuthority(input);
  const owner = authority.captureComposerImportOwner();
  assert.deepEqual(owner, { sessionId: 'session-a', navSection: 'sessions' });
  assert.equal(authority.isComposerImportOwnerActive(owner), true);
  assert.equal(authority.isNewChatSendSurfaceActive(owner), false);

  navSelectionRef.current = { section: 'computer-history' };
  assert.equal(authority.isShellSurfaceOwnerActive(owner), false);
  const moduleOwner = authority.captureComposerImportOwner();
  assert.equal(authority.isShellSurfaceOwnerActive(moduleOwner), true);
  assert.equal(authority.isComposerImportOwnerActive(moduleOwner), false);
  navSelectionRef.current = { section: 'sessions' };
  // Requested selection may change before the displayed active Session ref.
  selectedId = 'session-b';
  assert.equal(authority.isComposerImportOwnerActive(owner), false);

  activeIdRef.current = undefined;
  selectedId = undefined;
  const newTask = authority.captureComposerImportOwner();
  assert.equal(authority.isNewChatSendSurfaceActive(newTask), true);
  const nextTarget = createComposerSurfaceAuthority({ ...input, newTaskDraftKey: 'local/project-b' });
  assert.equal(nextTarget.isNewChatSendSurfaceActive(newTask), false);
  assert.equal(nextTarget.isNewChatSendSurfaceActive(nextTarget.captureComposerImportOwner()), true);
});

test('active Composer claims retain their captured instance and reject changed navigation or Session', () => {
  const appended: string[] = [];
  const activeIdRef: { current: string | undefined } = { current: 'session-a' };
  const navSelectionRef: { current: NavSelection } = { current: { section: 'sessions' } };
  const composerRef: { current: { appendText(text: string): void } | null } = {
    current: { appendText: (text) => appended.push(text) },
  };
  const capture = () => captureActiveComposerClaim(activeIdRef, navSelectionRef, composerRef);
  const claim = capture();
  assert.ok(claim);
  assert.equal(claim.isCurrent(), true);
  claim.append('history context');
  assert.deepEqual(appended, ['history context']);

  navSelectionRef.current = { section: 'computer-history' };
  assert.equal(claim.isCurrent(), false);
  assert.equal(capture(), undefined);
  navSelectionRef.current = { section: 'sessions' };
  activeIdRef.current = 'session-b';
  assert.equal(claim.isCurrent(), false);
  activeIdRef.current = 'session-a';
  composerRef.current = { appendText: () => assert.fail('Must not use a replacement Composer') };
  assert.equal(claim.isCurrent(), false);
  claim.append('captured destination');
  assert.deepEqual(appended, ['history context', 'captured destination']);
  composerRef.current = null;
  assert.equal(capture(), undefined);
  activeIdRef.current = undefined;
  composerRef.current = { appendText: () => undefined };
  assert.equal(capture(), undefined);
});

test('Shell module routes preserve titlebar controls only for workspace-bearing surfaces', () => {
  const cases: readonly [NavSelection, string, boolean][] = [
    [{ section: 'sessions' }, 'im_hub', true],
    [{ section: 'extensions', module: 'skills' }, 'skills', false],
    [{ section: 'extensions', module: 'mcp' }, 'mcp', true],
    [{ section: 'automations', module: 'scheduled-tasks' }, 'cron', false],
    [{ section: 'automations', module: 'daily-review' }, 'daily-review', false],
    [{ section: 'computer-history' }, 'computer-history', false],
  ];
  for (const [selection, expectedView, workspaceActions] of cases) {
    const view = resolveShellDetailView(selection);
    assert.equal(view, expectedView);
    assert.equal(hasWorkspaceActions(view), workspaceActions);
  }
});
