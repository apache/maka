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
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { act, createElement, type ComponentProps, type ReactNode } from 'react';
import type { TaskSubmissionReadinessSnapshot } from '@maka/core/task-submission-readiness';
import { LocaleProvider, type ComposerHandle } from '@maka/ui';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { TaskReadinessComposer } from '../../renderer/features/conversation/testing.js';
import * as Conversation from '../../renderer/features/conversation/index.js';
import {
  OnboardingAuthorityProvider,
  type OnboardingAuthority,
  type OnboardingSnapshot,
} from '../../renderer/application/contracts/onboarding/onboarding-authority.js';
import {
  TaskReadinessNoticeConsumer,
  TaskReadinessProvider,
  TaskReadinessServicesProvider,
  type TaskReadinessServices,
} from '../../renderer/features/conversation/index.js';
import { getTaskReadinessCopy } from '../../renderer/locales/task-readiness-copy.js';
import {
  createDesktopTaskReadinessServices,
  type DesktopTaskReadinessBridge,
} from '../../renderer/platform/desktop/create-task-readiness-services.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

afterEach(() => {
  cleanupFakeDom();
});

type Request = Parameters<TaskReadinessServices['readSession']>[1];
type NewTaskTarget = Parameters<TaskReadinessServices['readNewTask']>[0];
type NoticeView = ComponentProps<ComponentProps<typeof TaskReadinessNoticeConsumer>['surface']>;

const copy = getTaskReadinessCopy('en');

function snapshot(
  id: 'runtime' | 'workspace' | 'model_target',
  options: { readonly picker?: boolean } = {},
): TaskSubmissionReadinessSnapshot {
  const dimension = {
    id,
    state: 'unavailable' as const,
    authority: id === 'runtime'
      ? ('runtime_host' as const)
      : id === 'workspace'
        ? ('workspace_execution' as const)
        : ('connection_readiness' as const),
    checkedAt: 1,
    ...(options.picker ? { repairTarget: { kind: 'workspace_picker' as const } } : {}),
  };
  return { checkedAt: 1, state: 'unavailable', dimensions: [dimension], blockers: [dimension] };
}

const READY: TaskSubmissionReadinessSnapshot = { checkedAt: 1, state: 'ready', dimensions: [], blockers: [] };

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

/** Records every read and answers it only when the test settles it. */
function recordingServices() {
  const reads: Array<{
    readonly kind: 'session' | 'new_task';
    readonly target: string | NewTaskTarget;
    readonly request: Request;
    readonly answer: ReturnType<typeof deferred<TaskSubmissionReadinessSnapshot>>;
  }> = [];
  const listeners = new Set<() => void>();
  const services: TaskReadinessServices = {
    subscribeChanges(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    readSession(sessionId, request) {
      const answer = deferred<TaskSubmissionReadinessSnapshot>();
      reads.push({ kind: 'session', target: sessionId, request, answer });
      return answer.promise;
    },
    readNewTask(target, request) {
      const answer = deferred<TaskSubmissionReadinessSnapshot>();
      reads.push({ kind: 'new_task', target, request, answer });
      return answer.promise;
    },
  };
  return { services, reads, changed: () => { for (const listener of listeners) listener(); } };
}

function noticeRecorder() {
  const rendered: NoticeView[] = [];
  function Surface(props: NoticeView) {
    rendered.push(props);
    return createElement('p', null, props.title);
  }
  return { Surface, rendered, latest: () => rendered.at(-1) };
}

type OwnerProps = Omit<Parameters<typeof TaskReadinessProvider>[0], 'children' | 'openSessionWorkspaceRecovery'> & {
  openSessionWorkspaceRecovery?: (sessionId: string) => void;
  /** Delivered as the onboarding authority's snapshot; a new value reads again. */
  refreshKey: unknown;
};

/** An onboarding authority whose snapshot is the given key, so a new key is a new snapshot. */
function onboardingWith(snapshot: unknown): OnboardingAuthority {
  return {
    getProjection: () => ({ snapshot: snapshot as OnboardingSnapshot, failed: false }),
    subscribe: () => () => {},
    refresh: () => {},
    skipInitialOnboarding: async () => {},
  };
}

const ignoreRecovery = () => {};

function owner(services: TaskReadinessServices, { refreshKey, ...props }: OwnerProps, children: ReactNode) {
  return createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(OnboardingAuthorityProvider, {
      value: onboardingWith(refreshKey),
      children: createElement(TaskReadinessServicesProvider, {
        services,
        children: createElement(TaskReadinessProvider, {
          openSessionWorkspaceRecovery: ignoreRecovery,
          ...props,
          children,
        }),
      }),
    }),
  });
}

const sessionRequest: Request = { connectionSlug: 'openai', model: 'gpt-5', cwd: '/work/a' };
const newTaskTarget: NewTaskTarget = { profileId: 'local', hostId: 'host-1', projectId: 'project-1' };

describe('TaskReadinessProvider', () => {
  test('a fixed unavailable worktree explains the send blocker without offering a different workspace', async () => {
    const { root } = installReactRenderer();
    const { services, reads } = recordingServices();
    const notice = noticeRecorder();
    await act(async () => root.render(owner(services, {
      request: { ...sessionRequest, workspaceFixed: true }, refreshKey: {}, sessionId: 'a',
    }, createElement(TaskReadinessNoticeConsumer, { surface: notice.Surface }))));
    await act(async () => reads[0]!.answer.resolve(snapshot('workspace')));
    assert.equal(notice.latest()?.title, 'This conversation’s worktree is unavailable. Messages cannot be sent right now.');
    assert.equal(notice.latest()?.description, '');
    assert.equal(notice.latest()?.actionLabel, copy.workspace.actionLabel.retry);
  });

  test('cleanup disables sending while preserving an editable draft, then recovery enables it', async () => {
    const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
    const globals = {
      document, window, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node,
      MutationObserver: window.MutationObserver,
      ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
      CSS: { escape: (value: string) => value },
      getComputedStyle: () => ({ getPropertyValue: () => '', paddingTop: '0', paddingBottom: '0' }),
      requestAnimationFrame: () => 0, cancelAnimationFrame() {}, IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    window.getSelection = () => null;
    document.getSelection = () => null;
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList;
    // Match browser attribute casing; linkedom otherwise preserves React's key.
    const setAttribute = window.HTMLElement.prototype.setAttribute;
    window.HTMLElement.prototype.setAttribute = function (name, value) {
      return setAttribute.call(this, name === 'contentEditable' ? 'contenteditable' : name, value);
    };
    const root = createRoot(document.querySelector('#root')!);
    const { services, reads, changed } = recordingServices();
    const ref = { current: null as ComposerHandle | null };
    let sends = 0;
    const refreshKey = {};
    const render = (sessionId: string, sendBlocked = false) => owner(services, {
      request: { ...sessionRequest, workspaceFixed: true }, refreshKey, sessionId,
    }, createElement(TaskReadinessComposer, {
      ref, draftKey: sessionId, sendBlocked, onSend: () => { sends += 1; return false; }, onStop() {},
    }));
    const sendButton = () => document.querySelector('button[aria-label="Send"]')!;
    try {
      await act(async () => root.render(render('a')));
      await act(async () => reads[0]!.answer.resolve(READY));
      await act(async () => ref.current!.setDraft('a', 'keep this draft'));
      assert.notEqual(sendButton().getAttribute('aria-disabled'), 'true');
      await act(async () => changed());
      await act(async () => reads[1]!.answer.resolve(snapshot('workspace')));
      assert.equal(sendButton().getAttribute('aria-disabled'), 'true');
      const editor = document.querySelector('[contenteditable="true"]');
      assert.ok(editor, 'workspace failure does not disable editing');
      assert.equal(ref.current!.getText(), 'keep this draft');
      await act(async () => {
        document.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        const enter = new window.Event('keydown', { bubbles: true, cancelable: true });
        Object.defineProperties(enter, { key: { value: 'Enter' }, code: { value: 'Enter' } });
        editor.dispatchEvent(enter);
      });
      assert.equal(sends, 0, 'neither form submission nor Enter reaches the Host');
      await act(async () => changed());
      assert.equal(sendButton().getAttribute('aria-disabled'), 'true', 'rechecking must keep a confirmed blocker');
      await act(async () => reads[2]!.answer.reject(new Error('temporary read failure')));
      assert.equal(sendButton().getAttribute('aria-disabled'), 'true', 'a failed recheck is not recovery');
      await act(async () => window.dispatchEvent(new window.Event('focus')));
      await act(async () => reads[3]!.answer.resolve(READY));
      assert.notEqual(sendButton().getAttribute('aria-disabled'), 'true');
      assert.equal(ref.current!.getText(), 'keep this draft');
      await act(async () => {
        document.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      });
      assert.equal(sends, 1, 'the same submit path works once the workspace is ready');
      await act(async () => root.render(render('a', true)));
      assert.equal(sendButton().getAttribute('aria-disabled'), 'true', 'other send gates remain effective');
      await act(async () => changed());
      await act(async () => reads[4]!.answer.resolve(snapshot('workspace')));
      await act(async () => root.render(render('b')));
      await act(async () => ref.current!.setDraft('b', 'another draft'));
      assert.notEqual(sendButton().getAttribute('aria-disabled'), 'true', 'another Session is independent');
    } finally {
      await act(async () => root.unmount());
      window.HTMLElement.prototype.setAttribute = setAttribute;
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });

  test('reads the Session target and publishes only the latest answer', async () => {
    const { root, container } = installReactRenderer();
    const { services, reads } = recordingServices();
    const notice = noticeRecorder();
    const refreshKey = {};
    const view = createElement(TaskReadinessNoticeConsumer, { surface: notice.Surface });

    await act(async () => root.render(owner(services, { request: sessionRequest, refreshKey, sessionId: 'a' }, view)));
    await act(async () => root.render(owner(services, { request: sessionRequest, refreshKey, sessionId: 'b' }, view)));
    assert.deepEqual(reads.map(({ kind, target, request }) => ({ kind, target, request })), [
      { kind: 'session', target: 'a', request: sessionRequest },
      { kind: 'session', target: 'b', request: sessionRequest },
    ]);

    await act(async () => reads[1]!.answer.resolve(READY));
    await act(async () => reads[0]!.answer.resolve(snapshot('runtime')));
    assert.equal(container.textContent, '', 'a late answer for the previous Session does not publish');
    assert.equal(notice.rendered.length, 0);

    await act(async () => root.render(owner(services, { request: sessionRequest, refreshKey, sessionId: 'b' }, view)));
    assert.equal(reads.length, 2, 'an unrelated render does not read again');
  });

  test('clears the shown notice as soon as the request changes', async () => {
    const { root, container } = installReactRenderer();
    const { services, reads } = recordingServices();
    const notice = noticeRecorder();
    const refreshKey = {};
    const view = createElement(TaskReadinessNoticeConsumer, { surface: notice.Surface });

    await act(async () => root.render(owner(services, { request: sessionRequest, refreshKey, sessionId: 'a' }, view)));
    await act(async () => reads[0]!.answer.resolve(snapshot('runtime')));
    assert.equal(container.textContent, copy.runtime.title);

    const moved = { ...sessionRequest, cwd: '/work/b' };
    await act(async () => root.render(owner(services, { request: moved, refreshKey, sessionId: 'a' }, view)));
    assert.equal(container.textContent, '', 'the previous workspace answer is not shown for the new one');
    assert.deepEqual(reads[1]?.request, moved);

    await act(async () => reads[1]!.answer.reject(new Error('Host unavailable')));
    assert.equal(container.textContent, '', 'a failed read shows nothing');
  });

  test('reads the new-task target only without a Session, and nothing without either', async () => {
    const { root, container } = installReactRenderer();
    const { services, reads } = recordingServices();
    const notice = noticeRecorder();
    const refreshKey = {};
    const view = createElement(TaskReadinessNoticeConsumer, { surface: notice.Surface });

    await act(async () => root.render(owner(services, { request: {}, refreshKey, newTaskTarget }, view)));
    assert.deepEqual(reads.map(({ kind, target }) => ({ kind, target })), [{ kind: 'new_task', target: newTaskTarget }]);
    await act(async () => reads[0]!.answer.resolve(snapshot('runtime')));
    assert.equal(container.textContent, copy.runtime.title);

    // A shared Session has neither an owner Session nor a new-task target.
    await act(async () => root.render(owner(services, { request: sessionRequest, refreshKey }, view)));
    assert.equal(reads.length, 1);
    assert.equal(container.textContent, '');

    await act(async () => root.render(owner(services, { request: sessionRequest, refreshKey, sessionId: 'a', newTaskTarget }, view)));
    assert.equal(reads[1]?.kind, 'session', 'an owner Session takes precedence over a new-task target');
  });

  test('reads again for a new refresh key and for the retry action', async () => {
    const { root, container } = installReactRenderer();
    const { services, reads } = recordingServices();
    const notice = noticeRecorder();
    const view = createElement(TaskReadinessNoticeConsumer, { surface: notice.Surface });
    const onboarding = {};

    await act(async () => root.render(owner(services, { request: sessionRequest, refreshKey: onboarding, sessionId: 'a' }, view)));
    await act(async () => root.render(owner(services, { request: { ...sessionRequest }, refreshKey: onboarding, sessionId: 'a' }, view)));
    assert.equal(reads.length, 1, 'an equal request does not read again');

    await act(async () => root.render(owner(services, { request: sessionRequest, refreshKey: {}, sessionId: 'a' }, view)));
    assert.equal(reads.length, 2);
    await act(async () => reads[1]!.answer.resolve(snapshot('runtime')));
    assert.equal(notice.latest()?.status, 'error');
    assert.equal(notice.latest()?.actionLabel, copy.runtime.actionLabel);

    await act(async () => notice.latest()?.onAction?.());
    assert.equal(reads.length, 3);
    assert.equal(container.textContent, '', 'retry clears the notice until the new answer');
  });

  test('routes a workspace blocker to its Session\'s recovery or to Add Project, and hides the action without one', async () => {
    const { root } = installReactRenderer();
    const { services, reads } = recordingServices();
    const notice = noticeRecorder();
    const view = createElement(TaskReadinessNoticeConsumer, { surface: notice.Surface });
    const refreshKey = {};
    const recovered: string[] = [];
    const openSessionWorkspaceRecovery = (sessionId: string) => { recovered.push(sessionId); };
    let added = 0;
    const addProject = () => { added += 1; };

    await act(async () => root.render(owner(services, {
      request: sessionRequest, refreshKey, sessionId: 'a', workspaceRecoverySessionId: 'a', openSessionWorkspaceRecovery, addProject,
    }, view)));
    await act(async () => reads[0]!.answer.resolve(snapshot('workspace', { picker: true })));
    assert.equal(notice.latest()?.actionLabel, copy.workspace.actionLabel.workspace_picker);
    await act(async () => notice.latest()?.onAction?.());
    assert.deepEqual(recovered, ['a'], 'a Session\'s blocker opens that Session\'s recovery');
    assert.equal(added, 0);
    assert.equal(reads.length, 1, 'the picker action does not read again');

    await act(async () => root.render(owner(services, { request: sessionRequest, refreshKey, sessionId: 'a', addProject }, view)));
    await act(async () => notice.latest()?.onAction?.());
    assert.equal(added, 1, 'without a Session the blocker adds a project');

    await act(async () => root.render(owner(services, { request: sessionRequest, refreshKey, sessionId: 'a' }, view)));
    assert.equal(notice.latest()?.onAction, undefined);

    await act(async () => root.render(owner(services, { request: sessionRequest, refreshKey: {}, sessionId: 'a', addProject }, view)));
    await act(async () => reads[1]!.answer.resolve(snapshot('workspace')));
    assert.equal(notice.latest()?.actionLabel, copy.workspace.actionLabel.retry);
    await act(async () => notice.latest()?.onAction?.());
    assert.equal(added, 1);
    assert.equal(reads.length, 3, 'a workspace blocker without a picker target retries');
  });

  test('a shell render with the same facts and commands leaves the notice reader alone', async () => {
    const { root } = installReactRenderer();
    const { services, reads } = recordingServices();
    const notice = noticeRecorder();
    const view = createElement(TaskReadinessNoticeConsumer, { surface: notice.Surface });
    const refreshKey = {};
    const openSessionWorkspaceRecovery = () => {};
    const render = (recoverySessionId: string) => owner(services, {
      request: { ...sessionRequest }, refreshKey, sessionId: 'a',
      workspaceRecoverySessionId: recoverySessionId, openSessionWorkspaceRecovery,
    }, view);

    await act(async () => root.render(render('a')));
    await act(async () => reads[0]!.answer.resolve(snapshot('workspace', { picker: true })));
    const rendered = notice.rendered.length;
    await act(async () => root.render(render('a')));
    assert.equal(notice.rendered.length, rendered, 'a fresh request object and equal facts publish nothing new');
    await act(async () => root.render(render('b')));
    assert.equal(notice.rendered.length, rendered + 1, 'a new recovery target does');
  });

  test('model blockers stay with their own recovery surfaces', async () => {
    const { root, container } = installReactRenderer();
    const { services, reads } = recordingServices();
    const notice = noticeRecorder();
    const view = createElement(TaskReadinessNoticeConsumer, { surface: notice.Surface });

    await act(async () => root.render(owner(services, { request: sessionRequest, refreshKey: {}, sessionId: 'a' }, view)));
    await act(async () => reads[0]!.answer.resolve(snapshot('model_target')));
    assert.equal(container.textContent, '');
    assert.equal(notice.rendered.length, 0);
  });

  test('keeps the answer while the reader unmounts and remounts', async () => {
    const { root, container } = installReactRenderer();
    const { services, reads } = recordingServices();
    const notice = noticeRecorder();
    const refreshKey = {};
    const render = (readerMounted: boolean) => owner(
      services,
      { request: sessionRequest, refreshKey, sessionId: 'a' },
      readerMounted ? createElement(TaskReadinessNoticeConsumer, { surface: notice.Surface }) : null,
    );

    await act(async () => root.render(render(true)));
    await act(async () => reads[0]!.answer.resolve(snapshot('runtime')));
    await act(async () => root.render(render(false)));
    assert.equal(container.textContent, '');
    await act(async () => root.render(render(true)));
    assert.equal(container.textContent, copy.runtime.title);
    assert.equal(reads.length, 1, 'hiding the transcript neither drops nor restarts the read');
  });

  test('the reader requires its owner', () => {
    const { root } = installReactRenderer();
    const notice = noticeRecorder();
    assert.throws(
      () => act(() => root.render(createElement(LocaleProvider, {
        locale: 'en',
        children: createElement(TaskReadinessNoticeConsumer, { surface: notice.Surface }),
      }))),
      /TaskReadinessProvider is required/,
    );
  });
});

describe('Desktop task readiness adapter', () => {
  test('maps the two reads onto their bridge calls', async () => {
    const calls: unknown[] = [];
    const bridge: DesktopTaskReadinessBridge = {
      taskReadiness: {
        getSnapshot: async (input, sessionId) => {
          calls.push(['taskReadiness.getSnapshot', input, sessionId]);
          return READY;
        },
      },
      newTasks: {
        subscribeChanges: () => () => {},
        getReadiness: async (target, input) => {
          calls.push(['newTasks.getReadiness', target, input]);
          return READY;
        },
      },
    };
    const services = createDesktopTaskReadinessServices(bridge);
    assert.equal(await services.readSession('session-1', { ...sessionRequest, workspaceFixed: true }), READY);
    assert.equal(await services.readNewTask(newTaskTarget, { cwd: '/work' }), READY);
    assert.deepEqual(calls, [
      ['taskReadiness.getSnapshot', sessionRequest, 'session-1'],
      ['newTasks.getReadiness', newTaskTarget, { cwd: '/work' }],
    ]);
  });
});

describe('Task readiness ownership', () => {
  const rendererRoot = resolve(fileURLToPath(new URL('../../../src/renderer/', import.meta.url)));

  function productionSources(root: string): string[] {
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return entry.name === '__tests__' || entry.name === 'stories' ? [] : productionSources(path);
      return /\.tsx?$/.test(entry.name) && entry.name !== 'testing.ts' ? [path] : [];
    });
  }

  function sourcesMatching(pattern: RegExp): string[] {
    return productionSources(rendererRoot)
      .filter((path) => pattern.test(readFileSync(path, 'utf8')))
      .map((path) => relative(rendererRoot, path).replace(/\\/g, '/'))
      .sort();
  }

  test('mounts one owner, one reader and one Desktop adapter', () => {
    assert.deepEqual(sourcesMatching(/<(?:Conversation\.)?TaskReadinessProvider\b/), ['app-shell.tsx']);
    assert.deepEqual(sourcesMatching(/<(?:Conversation\.)?TaskReadinessNoticeConsumer\b/), ['chat-message-surface.tsx']);
    assert.deepEqual(sourcesMatching(/create-task-readiness-services/), ['composition/desktop-feature-services.tsx']);
    assert.deepEqual(
      sourcesMatching(/\btaskReadiness\s*\.\s*getSnapshot\b|\.\s*getReadiness\s*\(/),
      ['platform/desktop/create-task-readiness-services.ts'],
    );
    assert.deepEqual(sourcesMatching(/\buseTaskSubmissionReadiness\s*\(/), [
      'features/conversation/controller/use-task-submission-readiness.ts',
      'features/conversation/ui/task-readiness-provider.tsx',
    ]);
  });

  test('AppShell and the transcript surface hold no readiness snapshot or notice', () => {
    const shell = readFileSync(join(rendererRoot, 'app-shell.tsx'), 'utf8');
    assert.doesNotMatch(shell, /useTaskSubmissionReadiness|deriveTaskReadinessNotice|taskReadinessNotice|taskReadiness\./);
    assert.doesNotMatch(readFileSync(join(rendererRoot, 'chat-message-surface.tsx'), 'utf8'), /taskReadinessNotice|onTaskReadinessAction/);
    for (const name of ['useTaskSubmissionReadiness', 'deriveTaskReadinessNotice', 'isTaskSubmissionHardBlocked', 'useTaskReadinessServices']) {
      assert.equal(name in Conversation, false, `${name} is not a public Conversation capability`);
    }
  });
});
