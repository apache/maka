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

import { strict as assert } from 'node:assert';
import { test, type TestContext } from 'node:test';
import { parseHTML } from 'linkedom';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { GitBranchReadResult } from '@maka/core/git-review';
import {
  createFakeWorkbarServices,
  useComposerGitBranch,
  WorkbarServicesProvider,
  type ComposerGitBranch,
  type WorkbarReviewService,
  type WorkbarServices,
} from '../../renderer/features/workbar/testing.js';

function installRenderer(t: TestContext) {
  const original = {
    document: globalThis.document,
    window: globalThis.window,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }).IS_REACT_ACT_ENVIRONMENT,
  };
  const { document, window } = parseHTML('<div id="root"></div>');
  window.getComputedStyle = () =>
    ({ direction: 'ltr', getPropertyValue: () => '' }) as unknown as CSSStyleDeclaration;
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
  t.after(() => {
    Object.assign(globalThis, original);
  });
  return document;
}

/** A review port whose `branch()` answers from a mutable value, counting calls. */
function reviewPort(answer: () => GitBranchReadResult): {
  service: WorkbarReviewService;
  reads: () => number;
} {
  let calls = 0;
  return {
    reads: () => calls,
    service: {
      read: async () => {
        throw new Error('not used');
      },
      branch: async () => {
        calls += 1;
        return answer();
      },
      subscribeSessionEvents: () => () => undefined,
    },
  };
}

function servicesWithReview(
  review: WorkbarReviewService,
  pty: { emit(sessionId: string): void } = { emit: () => undefined },
): WorkbarServices {
  // The fake base satisfies every other port; `review` and the PTY stream are
  // the two this hook consumes.
  return createFakeWorkbarServices({
    review,
    terminal: {
      ...createFakeWorkbarServices().terminal,
      subscribePtyData: (handler) => {
        pty.emit = (sessionId) => handler({ sessionId, ref: 'r', sequence: 0, data: 'x' });
        return () => undefined;
      },
    },
  });
}

test('useComposerGitBranch re-reads on focus and visibility, and follows a branch change', async (t) => {
  const document = installRenderer(t);
  let current: GitBranchReadResult = {
    ok: true,
    snapshot: { branch: 'feature/old', shortSha: null },
  };
  const port = reviewPort(() => current);
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);

  let observed: ComposerGitBranch | undefined;
  function Probe(): ReactElement {
    observed = useComposerGitBranch('session-1');
    return createElement('span', null, observed?.name ?? observed?.shortSha ?? '');
  }

  await act(() =>
    root.render(
      createElement(WorkbarServicesProvider, {
        services: servicesWithReview(port.service),
        children: createElement(Probe),
      }),
    ),
  );
  assert.equal(observed?.name, 'feature/old', 'the first read must land');
  assert.equal(port.reads(), 1);

  // The branch changes under the app (e.g. the integrated terminal), and the
  // user returns to the window — the chip must follow, not stay silently stale.
  current = { ok: true, snapshot: { branch: 'feature/new', shortSha: null } };
  await act(() => {
    window.dispatchEvent(new window.Event('focus'));
  });
  await act(async () => {});
  assert.equal(observed?.name, 'feature/new', 'a focus must re-read the branch');
  assert.equal(port.reads(), 2);

  // A detached HEAD after a checkout is reported as the short sha.
  current = { ok: true, snapshot: { branch: null, shortSha: 'abc1234' } };
  await act(() => {
    document.dispatchEvent(new window.Event('visibilitychange'));
  });
  await act(async () => {});
  assert.equal(observed?.shortSha, 'abc1234', 'a visibility change must re-read too');

  await act(() => root.unmount());
});

test('useComposerGitBranch renders nothing (undefined), never an empty chip', async (t) => {
  const document = installRenderer(t);
  const port = reviewPort(() => ({ ok: false, isGitRepo: false }));
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);

  let observed: ComposerGitBranch | undefined | null = null;
  function Probe(): ReactElement {
    observed = useComposerGitBranch('session-1');
    return createElement('span');
  }
  await act(() =>
    root.render(
      createElement(WorkbarServicesProvider, {
        services: servicesWithReview(port.service),
        children: createElement(Probe),
      }),
    ),
  );
  assert.equal(observed, undefined, 'a non-repository must yield undefined, not a husk');

  // No session at all: still undefined, and no read is issued.
  function NoSessionProbe(): ReactElement {
    observed = useComposerGitBranch(undefined);
    return createElement('span');
  }
  await act(() =>
    root.render(
      createElement(WorkbarServicesProvider, {
        services: servicesWithReview(port.service),
        children: createElement(NoSessionProbe),
      }),
    ),
  );
  assert.equal(observed, undefined);
  // The non-repository read above already ran once; no session must add none.
  assert.equal(port.reads(), 1, 'no session must not issue a read');

  await act(() => root.unmount());
});

test('useComposerGitBranch re-reads after the session terminal goes quiet (the in-app case)', async (t) => {
  const document = installRenderer(t);
  let current: GitBranchReadResult = {
    ok: true,
    snapshot: { branch: 'feature/before', shortSha: null },
  };
  const port = reviewPort(() => current);
  const pty = { emit: (_sessionId: string) => undefined };
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);

  let observed: ComposerGitBranch | undefined;
  function Probe(): ReactElement {
    observed = useComposerGitBranch('session-1');
    return createElement('span');
  }
  await act(() =>
    root.render(
      createElement(WorkbarServicesProvider, {
        services: servicesWithReview(port.service, pty),
        children: createElement(Probe),
      }),
    ),
  );
  assert.equal(observed?.name, 'feature/before');
  assert.equal(port.reads(), 1);

  // A command typed in this session's integrated terminal: output arrives with
  // no window blur and no new shell run, so only the PTY signal can see it.
  current = { ok: true, snapshot: { branch: 'feature/after', shortSha: null } };
  await act(() => {
    pty.emit('session-1');
  });
  // The read is debounced until the output settles.
  await act(() => new Promise((resolve) => setTimeout(resolve, 600)));
  assert.equal(observed?.name, 'feature/after', 'the chip must follow an in-app branch change');
  assert.equal(port.reads(), 2);

  // Output from ANOTHER session must not touch this chip.
  current = { ok: true, snapshot: { branch: 'feature/other', shortSha: null } };
  await act(() => {
    pty.emit('session-2');
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 600)));
  assert.equal(observed?.name, 'feature/after', 'another session\'s terminal must not move this chip');
  assert.equal(port.reads(), 2);

  await act(() => root.unmount());
});

test('an unchanged branch costs no re-render when the terminal re-reads', async (t) => {
  const document = installRenderer(t);
  const port = reviewPort(() => ({
    ok: true,
    snapshot: { branch: 'feature/same', shortSha: null },
  }));
  const pty = { emit: (_sessionId: string) => undefined };
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);

  let renders = 0;
  function Probe(): ReactElement {
    renders += 1;
    useComposerGitBranch('session-1');
    return createElement('span');
  }
  await act(() =>
    root.render(
      createElement(WorkbarServicesProvider, {
        services: servicesWithReview(port.service, pty),
        children: createElement(Probe),
      }),
    ),
  );
  const afterFirst = renders;

  // A busy terminal re-reads on each quiet gap; the answer is identical, so the
  // hook must not repaint the composer for it.
  await act(() => {
    pty.emit('session-1');
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 600)));
  assert.ok(port.reads() > 1, 'the quiet gap did re-read');
  assert.equal(renders, afterFirst, 'an unchanged branch must not re-render');

  await act(() => root.unmount());
});
