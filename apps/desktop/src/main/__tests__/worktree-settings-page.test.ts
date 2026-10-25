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

/// <reference types="vite/client" />

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { AstryxLocaleProvider, LocaleProvider, ToastProvider } from '@maka/ui';
import { deferred } from '@maka/core/test-only/async-primitives';
import type { WorktreeInfo, WorktreeSnapshot, WorktreeMutation } from '@maka/core/worktree';
import type { WorktreeServices } from '../../renderer/features/worktrees/index.js';

test('settings expose failed setup recovery and resume only after retry or skip succeeds', async (t) => {
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  Object.assign(window.HTMLElement.prototype, {
    showModal(this: HTMLElement) { this.setAttribute('open', ''); },
    close(this: HTMLElement) { this.removeAttribute('open'); },
  });
  const globals = {
    document, window,
    matchMedia: (media: string) => ({
      matches: false, media, onchange: null, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
    }),
    CSS: { escape: (value: string) => value },
    getComputedStyle: () => ({ backgroundImage: 'none', backgroundColor: 'transparent', getPropertyValue: () => '' }),
    HTMLElement: window.HTMLElement,
    HTMLIFrameElement: window.HTMLIFrameElement ?? class {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {}, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(window, { matchMedia: globals.matchMedia, scrollTo() {} });
  Object.assign(globalThis, globals);
  const hooks = registerHooks({ resolve(specifier, context, next) {
    return specifier.endsWith('.css')
      ? { url: 'data:text/javascript,export {}', shortCircuit: true }
      : next(specifier, context);
  } });
  const container = document.querySelector('#root')!;
  const root = createRoot(container);
  const checkout: WorktreeInfo = {
    projectId: 'project', name: 'maka-checkout', path: '/worktrees/maka-checkout',
    head: 'a'.repeat(40), branch: 'feature', isMain: false, managed: true,
    available: true, locked: false, sessionCount: 1, initialization: 'ready',
  };
  const failed: WorktreeInfo = {
    ...checkout, name: 'failed-setup', path: '/worktrees/failed-setup',
    initialization: 'failed', log: 'Setup needs a retry',
  };
  const snapshot: WorktreeSnapshot = {
    config: { rootDirectory: '/worktrees', projects: {} },
    projects: [{
      id: 'project', name: 'Example', mainPath: '/repo', config: {}, worktrees: [
        checkout, failed,
        { ...checkout, name: 'external-checkout', path: '/external', managed: false },
        { ...checkout, name: 'main-checkout', path: '/repo', isMain: true, managed: false },
        { ...checkout, name: 'missing-checkout', path: '/missing', available: false },
      ],
    }],
  };
  const listeners = new Set<() => void>();
  const mutations: WorktreeMutation[] = [];
  const resumed: string[] = [];
  const opened: string[] = [];
  let retrySucceeds = false;
  let initializationGate: Promise<void> | undefined;
  const queriedHosts: string[] = [];
  let resolveRemote!: (value: WorktreeSnapshot) => void;
  const remoteSnapshot = new Promise<WorktreeSnapshot>((resolve) => { resolveRemote = resolve; });
  const services: WorktreeServices = {
    subscribeChanges: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    query: async (host) => {
      queriedHosts.push(host.hostId);
      if (host.profileId === 'remote') return await remoteSnapshot;
      return structuredClone(snapshot);
    },
    mutate: async (host, input) => {
      assert.deepEqual(host, { profileId: 'local', hostId: 'host' });
      mutations.push(input);
      if (input.kind === 'configure') {
        assert.equal(input.projectId, 'project');
        snapshot.projects[0]!.config = structuredClone(input.config);
        return { kind: 'configured' };
      }
      assert.equal(input.kind, 'initialize');
      if (input.kind !== 'initialize') throw new Error('Unexpected mutation');
      assert.equal(input.path, failed.path);
      assert.equal(input.projectId, 'project');
      await initializationGate;
      failed.initialization = input.skip ? 'skipped' : retrySucceeds ? 'ready' : 'failed';
      failed.log = failed.initialization === 'failed' ? 'Still needs a retry' : 'Setup complete';
      return { kind: 'worktree', worktree: structuredClone(failed) };
    },
    resumeTask: async (host, path) => {
      assert.deepEqual(host, { profileId: 'local', hostId: 'host' });
      assert.ok(failed.initialization === 'ready' || failed.initialization === 'skipped');
      resumed.push(path);
      return 'original-task';
    },
    openTask: async () => undefined,
  };
  try {
    const { WorktreeSettingsPage, WorktreeServicesProvider } =
      await import('../../renderer/features/worktrees/index.js');
    const { RuntimeHostSettingsTarget } =
      await import('../../renderer/application/contracts/settings-presentation/runtime-host-settings-target.js');
    const renderHost = async (profileId: string, hostId: string, generation = '1') => act(async () => {
      root.render(createElement(LocaleProvider, { locale: 'en', children:
        createElement(AstryxLocaleProvider, { children:
          createElement(ToastProvider, { children:
            createElement(WorktreeServicesProvider, { services, children:
              createElement(RuntimeHostSettingsTarget, { host: { profileId, hostId }, generation, label: profileId, children:
                createElement(WorktreeSettingsPage, { onOpenSession: (id: string) => opened.push(id) }),
              }),
            }),
          }),
        }),
      }));
    });
    await renderHost('local', 'host');
    const names = () => [...container.querySelectorAll('.worktreeItem strong')]
      .map((item) => item.textContent);
    const count = () => container.querySelector('.worktreeProjectDisclosure > summary')?.textContent;
    assert.deepEqual(names(), ['maka-checkout', 'failed-setup']);
    assert.match(container.textContent ?? '', /\/worktrees\/maka-checkout/);
    assert.match(container.textContent ?? '', /feature/);
    assert.match(container.textContent ?? '', /Ready/);
    assert.match(container.textContent ?? '', /Initialization failed/);
    assert.match(count() ?? '', /Example2/);
    assert.doesNotMatch(container.textContent ?? '', /Unavailable|External|external-checkout|missing-checkout/);
    assert.match(container.textContent ?? '', /Retry initialization/);
    assert.match(container.textContent ?? '', /Continue without initialization/);
    assert.match(container.textContent ?? '', /Setup needs a retry/);
    assert.equal(container.querySelectorAll('.worktreeProjectSettings').length, 1);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.ok(container.querySelector('.worktreeLog[open]'), 'failed script output is expanded');
    const click = async (label: string) => {
      const button = [...container.querySelectorAll('button')].find((item) => item.textContent === label);
      assert.ok(button, `Missing recovery button: ${label}`);
      await act(async () => { button.click(); });
    };
    await click('Retry initialization');
    assert.equal(mutations.length, 1);
    assert.deepEqual(resumed, [], 'a failed retry never dispatches the retained message');
    assert.match(container.textContent ?? '', /Still needs a retry/);
    retrySucceeds = true;
    await click('Retry initialization');
    assert.deepEqual(resumed, [failed.path]);
    assert.deepEqual(opened, ['original-task']);
    assert.doesNotMatch(container.textContent ?? '', /Retry initialization/);

    failed.initialization = 'failed';
    await act(async () => { for (const listener of listeners) listener(); });
    await click('Continue without initialization');
    assert.deepEqual(mutations[2], { kind: 'initialize', projectId: 'project', path: failed.path, skip: true });
    assert.deepEqual(resumed, [failed.path, failed.path]);
    assert.deepEqual(opened, ['original-task', 'original-task']);

    for (const [name, skip] of [
      ['retry continues after leaving settings', false],
      ['skip continues on the original Host after switching Hosts', true],
    ] as const) {
      await t.test(name, async () => {
        failed.initialization = 'failed';
        await act(async () => { for (const listener of listeners) listener(); });
        const initialization = deferred<void>();
        initializationGate = initialization.promise;
        const resumedBefore = resumed.length;
        const openedBefore = opened.length;
        await click(skip ? 'Continue without initialization' : 'Retry initialization');
        assert.match(container.textContent ?? '', /Running setup script/);
        if (skip) await renderHost('remote', 'remote-host');
        else await act(async () => root.render(null));
        await act(async () => initialization.resolve());
        initializationGate = undefined;
        try {
          assert.equal(resumed.length, resumedBefore + 1, 'the accepted recovery must resume the original paused message');
          assert.equal(resumed.at(-1), failed.path);
          assert.equal(opened.length, openedBefore, 'completion must not navigate away from the newer UI');
          assert.equal(failed.initialization, skip ? 'skipped' : 'ready');
        } finally {
          await renderHost('local', 'host');
        }
        assert.doesNotMatch(container.textContent ?? '', /Retry initialization/);
      });
    }

    await t.test('background configuration refresh preserves dirty scripts and merges untouched fields', async () => {
      snapshot.projects[0]!.config = { setupScript: 'npm ci', cleanupScript: 'echo old' };
      await act(async () => { for (const listener of listeners) listener(); });
      await act(async () => { container.querySelector<HTMLButtonElement>('.worktreeProjectSettings')!.click(); });
      const scripts = () => [...document.querySelectorAll<HTMLTextAreaElement>('.worktreeConfigurationBody textarea')];
      assert.equal(scripts().length, 2);
      const editScript = async (index: number, value: string) => act(async () => {
        const input = scripts()[index]!;
        input.value = value;
        // Linkedom does not dispatch React's synthetic change event for text fields.
        const key = Object.keys(input).find((candidate) => candidate.startsWith('__reactProps$'));
        assert.ok(key, 'missing React textarea props');
        const props = (input as unknown as Record<string, unknown>)[key] as {
          onChange(event: { target: HTMLTextAreaElement; defaultPrevented: boolean }): void;
        };
        props.onChange({ target: input, defaultPrevented: false });
      });
      const save = () => [...document.querySelectorAll<HTMLButtonElement>('.worktreeConfigurationActions button')][0]!;
      for (const [index, field, otherField] of [
        [0, 'setupScript', 'cleanupScript'],
        [1, 'cleanupScript', 'setupScript'],
      ] as const) {
        const localEdit = `echo local ${field}`;
        await editScript(index, localEdit);
        snapshot.projects[0]!.config = {
          ...snapshot.projects[0]!.config,
          [field]: `echo conflicting remote ${field}`,
          [otherField]: `echo remote ${otherField}`,
          rootDirectory: '/remote/root',
          defaultMode: 'new',
        };
        await act(async () => { for (const listener of listeners) listener(); });
        assert.equal(scripts()[index]!.value, localEdit, 'refresh must retain the unsaved script');
        assert.equal(scripts()[1 - index]!.value, `echo remote ${otherField}`, 'untouched scripts adopt remote edits');
        assert.equal(save().disabled, false);
        await act(async () => { save().click(); });
        assert.deepEqual(mutations.at(-1), {
          kind: 'configure', projectId: 'project',
          config: {
            [field]: localEdit,
            [otherField]: `echo remote ${otherField}`,
            rootDirectory: '/remote/root',
            defaultMode: 'new',
          },
        });
        assert.equal(snapshot.projects[0]!.config[field], localEdit);
        assert.equal(save().disabled, true, 'acknowledged edits are no longer dirty');
        snapshot.projects[0]!.config = { ...snapshot.projects[0]!.config, [field]: `echo next ${field}` };
        await act(async () => { for (const listener of listeners) listener(); });
        assert.equal(scripts()[index]!.value, `echo next ${field}`, 'saved fields accept later remote changes');
        assert.equal(save().disabled, true);
      }
    });

    // Discovery changes must remove rows and counts without mutating the Host journal.
    snapshot.projects[0]!.worktrees = snapshot.projects[0]!.worktrees.map((item) =>
      ({ ...item, available: false }));
    await act(async () => { for (const listener of listeners) listener(); });
    assert.deepEqual(names(), []);
    assert.match(count() ?? '', /Example0/);
    assert.match(container.textContent ?? '', /No worktrees yet/);
    assert.doesNotMatch(count() ?? '', /Initialization failed/);

    // A restored checkout appears on the next refresh.
    snapshot.projects[0]!.worktrees = [checkout];
    await act(async () => { for (const listener of listeners) listener(); });
    assert.deepEqual(names(), ['maka-checkout']);
    assert.match(count() ?? '', /Example1/);

    // Switching targets retires the prior Host's data immediately, including
    // late reads, and a reconnect with the same identity starts a fresh query.
    await renderHost('remote', 'remote-host');
    assert.deepEqual(names(), []);
    assert.match(container.textContent ?? '', /Loading worktrees/);
    await renderHost('local', 'host');
    assert.deepEqual(names(), ['maka-checkout']);
    await act(async () => resolveRemote({
      config: { rootDirectory: '/remote/worktrees', projects: {} },
      projects: [{ ...snapshot.projects[0]!, name: 'Remote project', worktrees: [] }],
    }));
    assert.doesNotMatch(container.textContent ?? '', /Remote project/);
    await renderHost('remote', 'remote-host');
    assert.match(container.textContent ?? '', /Remote project/);
    assert.doesNotMatch(container.textContent ?? '', /maka-checkout/);
    assert.deepEqual(queriedHosts.slice(-3), ['remote-host', 'host', 'remote-host']);
    const beforeReconnect = queriedHosts.length;
    await renderHost('remote', 'remote-host', '2');
    assert.equal(queriedHosts.length, beforeReconnect + 1);
  } finally {
    await act(async () => root.unmount());
    hooks.deregister();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
