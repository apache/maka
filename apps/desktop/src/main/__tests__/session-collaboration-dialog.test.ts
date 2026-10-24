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
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { AstryxLocaleProvider, LocaleProvider, ToastProvider } from '@maka/ui';
import type { CollaborationAccessQueryResult, SessionTurnAccessRequest } from '@maka/runtime-host/protocol';
import { SettingsNavigationProvider } from '../../renderer/application/contracts/settings-presentation/settings-navigation.js';
import {
  createFakeSessionCollaborationServices,
  SessionCollaborationDialogRoot,
  SessionCollaborationServicesProvider,
  type PreparedSessionInvitation,
  type SessionCollaborationDialogProjection,
  type SessionCollaborationServices,
} from '../../renderer/features/session-collaboration/testing.js';

const originalGlobals = Object.fromEntries([
  'document', 'window', 'HTMLElement', 'HTMLIFrameElement', 'Event', 'Node', 'CSS',
  'getComputedStyle', 'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame',
  'IS_REACT_ACT_ENVIRONMENT',
].map((key) => [key, (globalThis as unknown as Record<string, unknown>)[key]]));
let root: Root | undefined;
let latest: SessionCollaborationDialogProjection;
let frameRenders = 0;
const settingsSections: string[] = [];
const animationFrames = new Map<number, FrameRequestCallback>();
let nextFrameId = 0;
const remoteSession = { id: 'session-a', name: 'Task A', profileKind: 'remote' };
const principal = {
  principalId: 'guest:alice', displayName: 'Alice', status: 'pending' as const,
  createdAt: '2026-01-01T00:00:00Z',
};
const invitation: PreparedSessionInvitation = {
  invitationCode: 'one-time-code', principalId: principal.principalId,
  expiresAt: '2099-01-01T00:00:00Z', grants: [], connectivity: { kind: 'configured' },
};

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  frameRenders = 0;
  settingsSections.length = 0;
  animationFrames.clear();
  Object.assign(globalThis, originalGlobals);
});

function ShellFrame({ dialog }: { dialog: SessionCollaborationDialogProjection }) {
  latest = dialog;
  frameRenders += 1;
  return createElement('main', null, 'shell');
}

async function mount(overrides: Partial<SessionCollaborationServices> = {}, strict = false) {
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const matchMedia = (media: string) => ({
    matches: false, media, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  });
  const getComputedStyle = () => ({ getPropertyValue: () => '' }) as unknown as CSSStyleDeclaration;
  Object.assign(window, { matchMedia, getComputedStyle, scrollTo() {} });
  Object.defineProperty(window, 'maka', {
    configurable: true,
    get() { throw new Error('The sharing feature must use injected services'); },
  });
  Object.assign(window.HTMLElement.prototype, {
    showModal(this: HTMLElement) { this.setAttribute('open', ''); },
    close(this: HTMLElement) { this.removeAttribute('open'); },
  });
  Object.assign(globalThis, {
    document, window, matchMedia, getComputedStyle,
    HTMLElement: window.HTMLElement, HTMLIFrameElement: window.HTMLIFrameElement ?? class {},
    Event: window.Event, Node: window.Node, CSS: { escape: (value: string) => value },
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const id = ++nextFrameId;
      animationFrames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id: number) => { animationFrames.delete(id); },
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  root = createRoot(container);
  const feature = createElement(SessionCollaborationDialogRoot, {
    children: (dialog) => createElement(ShellFrame, { dialog }),
  });
  await act(async () => {
    root!.render(createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(AstryxLocaleProvider, {
        children: createElement(ToastProvider, {
          children: createElement(SettingsNavigationProvider, {
            navigation: { openSettingsSection: (section) => { settingsSections.push(section); } },
            children: createElement(SessionCollaborationServicesProvider, {
              services: createFakeSessionCollaborationServices(overrides),
              children: strict ? createElement(StrictMode, null, feature) : feature,
            }),
          }),
        }),
      }),
    }));
  });
  return document;
}

async function open(session = remoteSession) {
  await act(async () => latest.openSession(session));
}

async function click(document: Document, label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent === label);
  assert.ok(button, `missing button: ${label}`);
  assert.equal(button.disabled, false, `disabled button: ${label}`);
  await act(async () => button.click());
  // Toast confirmation deliberately opens/resolves on the next browser frame.
  await act(async () => {
    const callbacks = [...animationFrames.values()];
    animationFrames.clear();
    for (const callback of callbacks) callback(0);
  });
}

test('owns the dialog below the shell and keeps target changes and polling reader-local', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reads: string[] = [];
  const document = await mount({ getAccess: async (sessionId) => {
    reads.push(sessionId);
    return { principals: [], grants: [] };
  } });
  assert.equal(latest.isOpen, false);
  assert.deepEqual(reads, []);
  const opener = latest.openSession;
  await open();
  assert.equal(latest.isOpen, true);
  assert.match(document.body.textContent, /Task A/u);
  const openProjection = latest;
  const openRenders = frameRenders;
  await act(async () => t.mock.timers.tick(2_000));
  assert.deepEqual(reads, ['session-a', 'session-a']);
  assert.equal(frameRenders, openRenders, 'polling does not re-render the shell');
  await open({ ...remoteSession, id: 'session-b', name: 'Task B' });
  assert.equal(latest, openProjection, 'target data is not part of the shell projection');
  assert.equal(frameRenders, openRenders);
  assert.match(document.body.textContent, /Task B/u);
  await click(document, 'Done');
  assert.equal(latest.isOpen, false);
  assert.equal(latest.openSession, opener);
  const readCount = reads.length;
  await act(async () => t.mock.timers.tick(10_000));
  assert.equal(reads.length, readCount, 'closing releases the poll timer');
});

test('does not publish an old target read or restart its poll after target replacement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolveOld!: (access: CollaborationAccessQueryResult) => void;
  const reads: string[] = [];
  const document = await mount({ getAccess: (sessionId) => {
    reads.push(sessionId);
    return sessionId === 'session-a'
      ? new Promise((resolve) => { resolveOld = resolve; })
      : Promise.resolve({ principals: [], grants: [] });
  } });
  await open();
  await open({ ...remoteSession, id: 'session-b', name: 'Task B' });
  await act(async () => resolveOld({ principals: [principal], grants: [] }));
  assert.doesNotMatch(document.body.textContent, /Alice/u);
  await act(async () => t.mock.timers.tick(2_000));
  assert.deepEqual(reads, ['session-a', 'session-b', 'session-b']);
});

test('cleans up in-flight polling on unmount under StrictMode', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const resolvers: Array<(access: CollaborationAccessQueryResult) => void> = [];
  let reads = 0;
  await mount({ getAccess: () => {
    reads += 1;
    return new Promise((resolve) => resolvers.push(resolve));
  } }, true);
  await open();
  assert.ok(reads > 0);
  await act(async () => root!.unmount());
  root = undefined;
  const atUnmount = reads;
  await act(async () => { for (const resolve of resolvers) resolve({ principals: [], grants: [] }); });
  await act(async () => t.mock.timers.tick(10_000));
  assert.equal(reads, atUnmount);
});

test('closes local sharing and opens the existing Settings destination when remote access is off', async () => {
  const document = await mount({
    isLocalRemoteAccessEnabled: async () => false,
    getAccess: async () => assert.fail('local access must be enabled before querying grants'),
    prepareInvitation: async () => assert.fail('must not prepare before enabling remote access'),
  });
  await open({ ...remoteSession, profileKind: 'local' });
  await click(document, 'Create invitation');
  assert.equal(latest.isOpen, false);
  assert.deepEqual(settingsSections, ['projects']);
});

test('rechecks local remote access immediately before invitation creation', async () => {
  let enabled = true;
  const document = await mount({
    isLocalRemoteAccessEnabled: async () => enabled,
    prepareInvitation: async () => assert.fail('access was disabled after the projection loaded'),
  });
  await open({ ...remoteSession, profileKind: 'local' });
  enabled = false;
  await click(document, 'Create invitation');
  assert.equal(latest.isOpen, false);
  assert.deepEqual(settingsSections, ['projects']);
});

test('requires explicit insecure confirmation, then copies the injected invitation', async () => {
  const prepares: unknown[][] = [];
  const copied: string[] = [];
  const document = await mount({
    isLocalRemoteAccessEnabled: async () => assert.fail('remote Sessions do not use local access'),
    getAccess: async () => ({ principals: [principal], grants: [] }),
    prepareInvitation: async (...args) => {
      prepares.push(args);
      return args[2]
        ? { kind: 'prepared', invitation }
        : { kind: 'insecure_confirmation_required' };
    },
    writeInvitationClipboard: async (text) => { copied.push(text); },
  });
  await open();
  const shellRenders = frameRenders;
  await click(document, 'Create invitation');
  assert.deepEqual(prepares, [['session-a', 'observe', false]]);
  await click(document, 'Accept risk and create');
  assert.deepEqual(prepares, [['session-a', 'observe', false], ['session-a', 'observe', true]]);
  await click(document, 'Copy invitation');
  assert.deepEqual(copied, ['one-time-code']);
  assert.equal(frameRenders, shellRenders, 'invitation and toast updates stay below the shell');
});

test('keeps grant revocation and turn decisions bound to the dialog target', async () => {
  const calls: unknown[][] = [];
  const grant = {
    grantId: 'grant-a', principalId: principal.principalId, sessionId: remoteSession.id,
    createdAt: principal.createdAt, kind: 'session_turn_request' as const,
  };
  const request: SessionTurnAccessRequest = {
    requestId: 'request-a', principalId: principal.principalId, grantId: grant.grantId,
    intent: { sessionId: remoteSession.id, turnId: 'turn-a', content: { text: 'Please run' } },
    createdAt: principal.createdAt, state: { kind: 'pending' },
  };
  const document = await mount({
    getAccess: async () => ({ principals: [principal], grants: [grant] }),
    getTurnRequests: async () => ({ canRequestTurns: false, requests: [request] }),
    revokeGrant: async (...args) => { calls.push(['grant', ...args]); return { revoked: true }; },
    revokePrincipal: async (...args) => { calls.push(['principal', ...args]); return { revoked: true }; },
    decideTurnRequest: async (...args) => { calls.push(['decision', ...args]); return { kind: 'not_found' }; },
  });
  await open();
  await click(document, 'Revoke Turn requests');
  await click(document, 'Revoke');
  await click(document, 'Approve');
  await click(document, 'Reject');
  assert.deepEqual(calls, [
    ['grant', 'session-a', 'grant-a'], ['principal', 'session-a', 'guest:alice'],
    ['decision', 'session-a', 'request-a', 'approve'], ['decision', 'session-a', 'request-a', 'reject'],
  ]);
});

test('discards the previous invitation immediately when the target changes', async () => {
  const document = await mount({
    getAccess: async () => ({ principals: [principal], grants: [] }),
    prepareInvitation: async () => ({ kind: 'prepared', invitation }),
  });
  await open();
  await click(document, 'Create invitation');
  assert.equal(document.querySelector('textarea')?.value, 'one-time-code');
  await open({ ...remoteSession, id: 'session-b', name: 'Task B' });
  assert.equal(document.querySelector('textarea') === null, true, 'a new target has no previous invitation');
  assert.match(document.body.textContent, /Task B/u);
});

test('does not retry invitation creation when insecure confirmation is declined', async () => {
  let attempts = 0;
  const document = await mount({
    prepareInvitation: async () => {
      attempts += 1;
      return { kind: 'insecure_confirmation_required' };
    },
  });
  await open();
  await click(document, 'Create invitation');
  const confirmation = document.querySelector('.maka-confirm-modal');
  assert.ok(confirmation);
  const cancel = [...confirmation.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent === 'Done');
  assert.ok(cancel);
  await act(async () => cancel.click());
  await act(async () => {
    const callbacks = [...animationFrames.values()];
    animationFrames.clear();
    for (const callback of callbacks) callback(0);
  });
  assert.equal(attempts, 1);
  assert.equal(latest.isOpen, true);
  assert.equal(document.querySelector('textarea') === null, true, 'declining does not create an invitation');
});
