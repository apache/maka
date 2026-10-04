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
import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { LocaleProvider } from '@maka/ui';
import {
  type WorkbarServices,
  createFakeWorkbarServices,
  WorkbarServicesProvider,
  SessionReviewPanel,
} from '../../renderer/features/workbar/testing.js';

test('a saved failing comparison keeps the picker available and can recover', async () => {
  const { document, restore } = installDom();
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
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
      return {
        ok: true,
        snapshot: {
          ...branches, source: 'branch', repositoryRoot: '/repo',
          baseBranch: 'refs/heads/main', revision: 'recovered',
          files: [], additions: 0, deletions: 0, truncated: false,
        },
      };
    },
    subscribeSessionEvents: () => () => undefined,
  };
  const services = createFakeWorkbarServices({ review });
  try {
    services.reviewBaseBranchPreference.write('saved-session', 'refs/heads/gh-pages');
    await act(async () => {
      root.render(createElement(LocaleProvider, {
        locale: 'en',
        children: createElement(WorkbarServicesProvider, { services },
          createElement(SessionReviewPanel, { sessionId: 'saved-session', active: true })),
      }));
    });
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
  } finally {
    await act(async () => { root.unmount(); });
    restore();
  }
});

for (const reason of ['not_git_repository', 'workspace_unavailable', 'git_failed'] as const) {
  test(`a refresh clears stale branch options after ${reason}`, async () => {
    const { document, restore } = installDom();
    const container = document.querySelector('#root');
    assert.ok(container);
    const root = createRoot(container);
    let unavailable = false;
    const services = createFakeWorkbarServices({ review: {
      read: async () => unavailable
        ? { ok: false, reason }
        : { ok: true, snapshot: {
          source: 'branch', repositoryRoot: '/repo', currentBranch: 'feature',
          baseBranch: 'refs/heads/main',
          baseBranchOptions: [{ label: 'main', value: 'refs/heads/main' }],
          revision: 'initial', files: [], additions: 0, deletions: 0, truncated: false,
        } },
      subscribeSessionEvents: () => () => undefined,
    } });
    const render = (active: boolean) => root.render(createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(WorkbarServicesProvider, { services },
        createElement(SessionReviewPanel, { sessionId: 'vanished-repo', active })),
    }));
    try {
      await act(async () => { render(true); });
      assert.ok(container.querySelector('.maka-session-review-base-branch'));
      await act(async () => { render(false); });
      unavailable = true;
      await act(async () => { render(true); });
      assert.equal(container.querySelector('.maka-session-review-base-branch'), null);
    } finally {
      await act(async () => { root.unmount(); });
      restore();
    }
  });
}

test('a task directory outside any repository guides instead of failing', async () => {
  const { document, restore } = installDom();
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  let reads = 0;
  const services = createFakeWorkbarServices({ review: {
    read: async () => {
      reads += 1;
      return { ok: false, reason: 'not_git_repository', cwd: '/tmp/plain-task' };
    },
    subscribeSessionEvents: () => () => undefined,
  } });
  try {
    await act(async () => {
      root.render(createElement(LocaleProvider, {
        locale: 'en',
        children: createElement(WorkbarServicesProvider, { services },
          createElement(SessionReviewPanel, { sessionId: 'plain-task', active: true })),
      }));
    });
    assert.match(container.textContent ?? '', /not a Git repository/);
    assert.match(container.textContent ?? '', /git init/);
    assert.match(container.textContent ?? '', /Task directory: \/tmp\/plain-task/);
    const retry = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Retry');
    assert.equal(retry, undefined, 'retrying cannot turn a directory into a repository');
    const refresh = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Refresh');
    assert.ok(refresh, 'git init in a side terminal needs a manual refresh affordance');
    assert.equal(reads, 1);
    await act(async () => { refresh.click(); });
    assert.equal(reads, 2, 'refresh re-reads the source after an out-of-band git init');
  } finally {
    await act(async () => { root.unmount(); });
    restore();
  }
});

test('an unavailable workspace keeps retry and names the recovery path', async () => {
  const { document, restore } = installDom();
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  const services = createFakeWorkbarServices({ review: {
    read: async () => ({ ok: false, reason: 'workspace_unavailable', cwd: '/tmp/vanished-task' }),
    subscribeSessionEvents: () => () => undefined,
  } });
  try {
    await act(async () => {
      root.render(createElement(LocaleProvider, {
        locale: 'en',
        children: createElement(WorkbarServicesProvider, { services },
          createElement(SessionReviewPanel, { sessionId: 'vanished-task', active: true })),
      }));
    });
    assert.match(container.textContent ?? '', /unavailable/);
    assert.match(container.textContent ?? '', /may have been moved/);
    assert.match(container.textContent ?? '', /Task directory: \/tmp\/vanished-task/);
    const retry = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Retry');
    assert.ok(retry, 'restoring the directory makes a retry meaningful');
  } finally {
    await act(async () => { root.unmount(); });
    restore();
  }
});

for (const reason of ['git_failed', 'unborn_repository'] as const) {
  test(`a ${reason} read failure keeps the error banner and retry`, async () => {
    const { document, restore } = installDom();
    const container = document.querySelector('#root');
    assert.ok(container);
    const root = createRoot(container);
    const services = createFakeWorkbarServices({ review: {
      read: async () => ({ ok: false, reason, cwd: '/tmp/live-task' }),
      subscribeSessionEvents: () => () => undefined,
    } });
    try {
      await act(async () => {
        root.render(createElement(LocaleProvider, {
          locale: 'en',
          children: createElement(WorkbarServicesProvider, { services },
            createElement(SessionReviewPanel, { sessionId: 'failed-read', active: true })),
        }));
      });
      assert.match(container.textContent ?? '', /Could not read|no commit to compare/);
      const retry = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Retry');
      assert.ok(retry, 'a retriable read failure keeps its retry');
      if (reason === 'git_failed') {
        assert.doesNotMatch(container.textContent ?? '', /Task directory:/);
      }
    } finally {
      await act(async () => { root.unmount(); });
      restore();
    }
  });
}

test('a disappeared saved branch clears the pin and retries with the dynamic default', async () => {
  const { document, restore } = installDom();
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
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
      return {
        ok: true,
        snapshot: {
          currentBranch: 'feature',
          baseBranchOptions: [{ label: 'main', value: 'refs/heads/main' }],
          source: 'branch', repositoryRoot: '/repo',
          baseBranch: 'refs/heads/main', revision: 'recovered',
          files: [], additions: 0, deletions: 0, truncated: false,
        },
      };
    },
    subscribeSessionEvents: () => () => undefined,
  };
  const services = createFakeWorkbarServices({ review });
  try {
    services.reviewBaseBranchPreference.write(sessionId, 'refs/heads/gh-pages');
    await act(async () => {
      root.render(createElement(LocaleProvider, {
        locale: 'en',
        children: createElement(WorkbarServicesProvider, { services },
          createElement(SessionReviewPanel, { sessionId, active: true })),
      }));
    });
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
  } finally {
    await act(async () => { root.unmount(); });
    restore();
  }
});

test('a comparison switch spins the picker and dims the stale diff until it lands', async () => {
  const { document, restore } = installDom();
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
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
      return {
        ok: true,
        snapshot: {
          ...branches, source: 'branch', repositoryRoot: '/repo',
          baseBranch: baseBranch ?? 'refs/heads/main', revision: baseBranch ?? 'initial',
          files: [], additions: 0, deletions: 0, truncated: false,
        },
      };
    },
    subscribeSessionEvents: () => () => undefined,
  };
  const services = createFakeWorkbarServices({ review });
  try {
    await act(async () => {
      root.render(createElement(LocaleProvider, {
        locale: 'en',
        children: createElement(WorkbarServicesProvider, { services },
          createElement(SessionReviewPanel, { sessionId: 'switch-session', active: true })),
      }));
    });
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
  } finally {
    await act(async () => { root.unmount(); });
    restore();
  }
});

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
