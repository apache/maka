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
import { test, type TestContext } from 'node:test';
import type { GitReviewSnapshot } from '@maka/core/git-review';
import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { LocaleProvider } from '@maka/ui';
import type { SessionChangedEvent } from '@maka/core/session';
import {
  type WorkbarServices,
  createFakeWorkbarServices,
  WorkbarServicesProvider,
  SessionReviewPanel,
} from '../../renderer/features/workbar/testing.js';
import { SessionWorkspaceRecoveryContext } from '../../renderer/application/contracts/session-workspace-recovery-authority.js';

test('a saved failing comparison keeps the picker available and can recover', async (t) => {
  const { document, container, render } = panelHarness(t);
  const requests: Array<string | undefined> = [];
  const branches = {
    currentBranch: 'feature',
    baseBranchOptions: [
      { label: 'main', value: 'refs/heads/main' },
      { label: 'gh-pages', value: 'refs/heads/gh-pages' },
    ],
  };
  const review: WorkbarServices['review'] = {
    read: async ({ baseBranch }) => {
      requests.push(baseBranch);
      if (baseBranch === 'refs/heads/gh-pages') {
        return { ok: false, reason: 'git_failed', branches };
      }
      return emptyReview({ ...branches, revision: 'recovered' });
    },
    subscribeSessionEvents: () => () => undefined,
    subscribeSessionChanges: () => () => undefined,
  };
  const services = createFakeWorkbarServices({ review });
  services.reviewBaseBranchPreference.write('saved-session', 'refs/heads/gh-pages');
  await render(services, 'saved-session');
  assert.match(container.textContent ?? '', /Could not read Git workspace changes/);
  const trigger = container.querySelector<HTMLButtonElement>('.maka-session-review-base-branch button');
  assert.ok(trigger, 'failed initial read must preserve a comparison picker');
  await act(async () => { trigger.click(); });
  const main = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (option) => option.textContent === 'main');
  assert.ok(main, 'main remains selectable after the diff fails');
  await act(async () => { main.click(); });
  assert.deepEqual(requests, ['refs/heads/gh-pages', 'refs/heads/main']);
  assert.doesNotMatch(container.textContent ?? '', /Could not read Git workspace changes/);
  assert.ok(container.querySelector<HTMLButtonElement>('.maka-session-review-base-branch button'));
});

for (const reason of ['not_git_repository', 'workspace_unavailable', 'git_failed'] as const) {
  test(`a refresh clears stale branch options after ${reason}`, async (t) => {
    const { container, render } = panelHarness(t);
    let unavailable = false;
    const services = createFakeWorkbarServices({ review: {
      read: async () => unavailable
        ? { ok: false, reason }
        : emptyReview(),
      subscribeSessionEvents: () => () => undefined,
      subscribeSessionChanges: () => () => undefined,
    } });
    const expected: Record<typeof reason, RegExp> = {
      not_git_repository: /Changes require a Git repository/,
      workspace_unavailable: /This task’s folder is unavailable/,
      git_failed: /Could not read Git workspace changes/,
    };
    await render(services, 'vanished-repo', { active: true });
    assert.ok(container.querySelector('.maka-session-review-base-branch'));
    await render(services, 'vanished-repo', { active: false });
    unavailable = true;
    await render(services, 'vanished-repo', { active: true });
    assert.equal(container.querySelector('.maka-session-review-base-branch'), null);
    assert.match(container.textContent ?? '', expected[reason],
      `the ${reason} state names itself`);
    assert.doesNotMatch(container.textContent ?? '', /No changes in the current Git workspace/,
      'a failed read is never reported as an empty diff');
  });
}

test('a disappeared saved branch clears the pin and retries with the dynamic default', async (t) => {
  const { document, container, render } = panelHarness(t);
  const sessionId = 'disappeared-branch-session';
  const requests: Array<string | undefined> = [];
  const review: WorkbarServices['review'] = {
    read: async ({ baseBranch }) => {
      requests.push(baseBranch);
      if (requests.length === 1) {
        return { ok: false, reason: 'invalid_base_branch', branches: {
          currentBranch: 'feature',
          baseBranchOptions: [{ label: 'main', value: 'refs/heads/main' }],
        } };
      }
      assert.equal(services.reviewBaseBranchPreference.read(sessionId), null, 'clear storage before retrying');
      return emptyReview({ revision: 'recovered' });
    },
    subscribeSessionEvents: () => () => undefined,
    subscribeSessionChanges: () => () => undefined,
  };
  const services = createFakeWorkbarServices({ review });
  services.reviewBaseBranchPreference.write(sessionId, 'refs/heads/gh-pages');
  await render(services, sessionId);
  assert.deepEqual(requests, ['refs/heads/gh-pages', undefined]);
  assert.equal(services.reviewBaseBranchPreference.read(sessionId), null, 'the resolved default must remain unpinned');
  const trigger = container.querySelector<HTMLButtonElement>('.maka-session-review-base-branch button');
  assert.ok(trigger, 'automatic recovery restores the comparison picker');
  assert.match(trigger.textContent ?? '', /main/);
  await act(async () => { trigger.click(); });
  const selected = document.querySelector('[role="option"][aria-selected="true"]');
  assert.equal(selected?.textContent, 'main', 'the resolved default is selected in the picker');
  assert.equal(container.querySelector('[role="alert"]'), null, 'recovery leaves no error banner');
  assert.doesNotMatch(container.textContent ?? '', /Could not read Git workspace changes/);
  assert.equal(container.querySelector('[aria-busy="true"]'), null);
});

test('a comparison switch spins the picker and dims the stale diff until it lands', async (t) => {
  const { document, container, render } = panelHarness(t);
  const branches = {
    currentBranch: 'feature',
    baseBranchOptions: [
      { label: 'main', value: 'refs/heads/main' },
      { label: 'gh-pages', value: 'refs/heads/gh-pages' },
    ],
  };
  let landSlowRead: (() => void) | undefined;
  const review: WorkbarServices['review'] = {
    read: async ({ baseBranch }) => {
      if (baseBranch === 'refs/heads/gh-pages') {
        await new Promise<void>((resolve) => { landSlowRead = resolve; });
      }
      return emptyReview({
        ...branches, baseBranch: baseBranch ?? 'refs/heads/main',
        revision: baseBranch ?? 'initial',
      });
    },
    subscribeSessionEvents: () => () => undefined,
    subscribeSessionChanges: () => () => undefined,
  };
  const services = createFakeWorkbarServices({ review });
  await render(services, 'switch-session');
  assert.equal(container.querySelector('.maka-session-review-switching'), null);
  const trigger = container.querySelector<HTMLButtonElement>('.maka-session-review-base-branch button');
  assert.ok(trigger);
  await act(async () => { trigger.click(); });
  const ghPages = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (option) => option.textContent === 'gh-pages');
  assert.ok(ghPages);
  await act(async () => { ghPages.click(); });
  assert.ok(container.querySelector('.maka-session-review-switching'), 'the panel reports the pending switch');
  assert.ok(container.querySelector('.maka-session-review-base-branch [aria-busy="true"]'), 'the picker spins while the read is in flight');
  await act(async () => { landSlowRead?.(); });
  assert.equal(container.querySelector('.maka-session-review-switching'), null);
  assert.equal(container.querySelector('.maka-session-review-base-branch [aria-busy="true"]'), null);
});

test('a non-Git task directory shows neutral guidance, its directory and the recovery action — without Retry', async (t) => {
  const { container, render } = panelHarness(t);
  let recovered: string | undefined;
  let initialized = false;
  const services = createFakeWorkbarServices({ review: {
    read: async () => initialized
      ? emptyReview({
        repositoryRoot: '/tasks/plain', currentBranch: 'main',
        baseBranch: null, baseBranchOptions: [], revision: 'initialized',
      })
      : { ok: false, reason: 'not_git_repository', workspace: '/tasks/plain' },
    subscribeSessionEvents: () => () => undefined,
    subscribeSessionChanges: () => () => undefined,
  } });
  await render(services, 'plain-task', { recover: (sessionId: string) => { recovered = sessionId; } });
  assert.match(container.textContent ?? '', /Changes require a Git repository/);
  assert.match(container.textContent ?? '', /\/tasks\/plain/, 'guidance names this task’s directory');
  assert.equal(container.querySelector('[role="alert"]'), null, 'a capability state is not an error banner');
  const buttons = Array.from(container.querySelectorAll('button'));
  assert.equal(buttons.find((button) => button.textContent === 'Retry'), undefined,
    're-reading cannot make a directory a repository');
  const action = buttons.find((button) => button.textContent === 'Change task folder');
  assert.ok(action, 'the current-task recovery action is offered');
  await act(async () => { action.click(); });
  assert.equal(recovered, 'plain-task', 'recovery targets the current task');
  const refresh = buttons.find((button) => button.textContent === 'Refresh');
  assert.ok(refresh, 'external Git initialization can be refreshed without Retry');
  initialized = true;
  await act(async () => { refresh.click(); });
  assert.match(container.textContent ?? '', /No changes in the current Git workspace/);
});

test('an unavailable workspace keeps its directory, a real Retry and the recovery action', async (t) => {
  const { container, render } = panelHarness(t);
  let recovered: string | undefined;
  let restored = false;
  const services = createFakeWorkbarServices({ review: {
    read: async () => restored
      ? emptyReview({ revision: 'restored' })
      : { ok: false, reason: 'workspace_unavailable', workspace: '/tasks/missing' },
    subscribeSessionEvents: () => () => undefined,
    subscribeSessionChanges: () => () => undefined,
  } });
  await render(services, 'missing-task', { recover: (sessionId: string) => { recovered = sessionId; } });
  assert.match(container.textContent ?? '', /This task’s folder is unavailable/);
  assert.match(container.textContent ?? '', /\/tasks\/missing/, 'guidance names this task’s directory');
  const buttons = Array.from(container.querySelectorAll('button'));
  const recovery = buttons.find((button) => button.textContent === 'Change task folder');
  assert.ok(recovery, 'the current-task recovery action is offered');
  const retry = buttons.find((button) => button.textContent === 'Retry');
  assert.ok(retry, 'a directory can come back, so Retry stays');
  await act(async () => { recovery.click(); });
  assert.equal(recovered, 'missing-task', 'recovery targets the current task');
  restored = true;
  await act(async () => { retry.click(); });
  assert.match(container.textContent ?? '', /No changes in the current Git workspace/,
    'Retry re-reads the task’s actual workspace');
});

test('an unborn repository shows neutral guidance and can refresh after its first commit', async (t) => {
  const { container, render } = panelHarness(t);
  let committed = false;
  const services = createFakeWorkbarServices({ review: {
    read: async () => committed
      ? emptyReview({
        repositoryRoot: '/tasks/new-repo', currentBranch: 'main',
        baseBranch: null, baseBranchOptions: [], revision: 'committed',
      })
      : { ok: false, reason: 'unborn_repository', workspace: '/tasks/new-repo' },
    subscribeSessionEvents: () => () => undefined,
    subscribeSessionChanges: () => () => undefined,
  } });
  await render(services, 'unborn-task');
  assert.match(container.textContent ?? '', /This Git repository has no commit to compare yet/);
  assert.equal(container.querySelector('[role="alert"]'), null, 'a capability state is not an error banner');
  const buttons = Array.from(container.querySelectorAll('button'));
  assert.equal(buttons.find((button) => button.textContent === 'Retry'), undefined);
  const refresh = buttons.find((button) => button.textContent === 'Refresh');
  assert.ok(refresh, 'the first commit can be refreshed without Retry');
  committed = true;
  await act(async () => { refresh.click(); });
  assert.match(container.textContent ?? '', /No changes in the current Git workspace/);
});

test('a host-owned workspace shows neutral guidance with neither Retry nor recovery', async (t) => {
  const { container, render } = panelHarness(t);
  const services = createFakeWorkbarServices({ review: {
    read: async () => ({ ok: false, reason: 'remote_workspace' }),
    subscribeSessionEvents: () => () => undefined,
    subscribeSessionChanges: () => () => undefined,
  } });
  await render(services, 'remote-task', {
    recover: () => { throw new Error('recovery cannot apply to a host-owned workspace'); },
  });
  assert.match(container.textContent ?? '', /This task’s workspace is managed by a remote Runtime Host/);
  assert.equal(container.querySelector('[role="alert"]'), null, 'a capability state is not an error banner');
  const buttons = Array.from(container.querySelectorAll('button'));
  assert.equal(buttons.find((button) => button.textContent === 'Retry'), undefined);
  assert.equal(buttons.find((button) => button.textContent === 'Change task folder'), undefined,
    'a local-folder recovery cannot apply to a host-owned workspace');
});

test('a Git read failure keeps the error Banner with its detail and a working Retry', async (t) => {
  const { container, render } = panelHarness(t);
  let failed = true;
  let reads = 0;
  const services = createFakeWorkbarServices({ review: {
    read: async () => {
      reads += 1;
      return failed
        ? { ok: false, reason: 'git_failed', detail: 'fatal: unable to read tree' }
        : emptyReview({ revision: 'recovered' });
    },
    subscribeSessionEvents: () => () => undefined,
    subscribeSessionChanges: () => () => undefined,
  } });
  await render(services, 'failed-task');
  assert.ok(container.querySelector('[role="alert"]'), 'a read failure stays an error');
  assert.match(container.textContent ?? '', /Could not read Git workspace changes/);
  assert.match(container.textContent ?? '', /fatal: unable to read tree/, 'the Git detail survives');
  const retry = Array.from(container.querySelectorAll('button'))
    .find((button) => button.textContent === 'Retry');
  assert.ok(retry);
  failed = false;
  await act(async () => { retry.click(); });
  assert.equal(reads, 2, 'Retry re-reads the workspace');
  assert.match(container.textContent ?? '', /No changes in the current Git workspace/);
  assert.equal(container.querySelector('[role="alert"]'), null);
});

test('a workspace catalog change re-reads the task’s actual workspace', async (t) => {
  const { container, render } = panelHarness(t);
  let relocated = false;
  let reads = 0;
  let onSessionChange: ((event: SessionChangedEvent) => void) | undefined;
  const services = createFakeWorkbarServices({ review: {
    read: async () => {
      reads += 1;
      return relocated
        ? emptyReview({ revision: 'relocated' })
        : { ok: false, reason: 'workspace_unavailable', workspace: '/tasks/missing' };
    },
    subscribeSessionEvents: () => () => undefined,
    subscribeSessionChanges: (handler) => {
      onSessionChange = handler;
      return () => { onSessionChange = undefined; };
    },
  } });
  await render(services, 'moving-task');
  assert.match(container.textContent ?? '', /This task’s folder is unavailable/);
  relocated = true;
  // A change about another Session is not this task's recovery.
  await act(async () => {
    onSessionChange?.({ reason: 'updated', sessionId: 'other-task', ts: 0 });
    for (const reason of ['message-appended', 'status-change', 'turn-status-change', 'goal-change'] as const) {
      onSessionChange?.({ reason, sessionId: 'moving-task', ts: 0 });
    }
    onSessionChange?.({ reason: 'created', ts: 0 });
    onSessionChange?.({ reason: 'updated', ts: 0 });
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  assert.equal(reads, 1, 'unrelated catalog activity must not re-read Git');
  assert.match(container.textContent ?? '', /This task’s folder is unavailable/);
  await act(async () => {
    onSessionChange?.({ reason: 'updated', sessionId: 'moving-task', ts: 0 });
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  assert.match(container.textContent ?? '', /No changes in the current Git workspace/,
    'recovery refreshes the correct task');
  assert.equal(reads, 2);
});

function emptyReview(overrides: Partial<GitReviewSnapshot> = {}) {
  return {
    ok: true as const,
    snapshot: {
      source: 'branch' as const, repositoryRoot: '/repo', currentBranch: 'feature',
      baseBranch: 'refs/heads/main',
      baseBranchOptions: [{ label: 'main', value: 'refs/heads/main' }],
      revision: 'initial', files: [], additions: 0, deletions: 0, truncated: false,
      ...overrides,
    },
  };
}

function panelHarness(t: TestContext) {
  const { document, restore } = installDom();
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  t.after(async () => {
    try {
      await act(async () => { root.unmount(); });
    } finally {
      restore();
    }
  });
  return {
    document,
    container,
    render: async (
      services: WorkbarServices,
      sessionId: string,
      options: { active?: boolean; recover?: (sessionId: string) => void } = {},
    ) => {
      await act(async () => {
        root.render(createElement(LocaleProvider, {
          locale: 'en',
          children: createElement(WorkbarServicesProvider, { services },
            createElement(SessionWorkspaceRecoveryContext.Provider, { value: options.recover },
              createElement(SessionReviewPanel, { sessionId, active: options.active ?? true }))),
        }));
      });
    },
  };
}

function installDom() {
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const globals = {
    document, window,
    matchMedia: (media: string) => ({
      matches: false,
      media,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => true,
    }),
    HTMLElement: window.HTMLElement,
    HTMLIFrameElement: window.HTMLIFrameElement ?? class HTMLIFrameElement {},
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => undefined,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  return {
    document,
    restore: () => {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}
