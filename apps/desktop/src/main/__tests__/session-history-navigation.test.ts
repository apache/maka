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
import { afterEach, it } from 'node:test';
import { act, createElement } from 'react';
import { parseHTML } from 'linkedom';
import { installReactRenderer, cleanupFakeDom, FakeElement } from './fake-dom.js';
import { createSessionCatalogController } from '../../renderer/application/contracts/session-catalog/session-catalog-state.js';
import { SessionHistoryNavigation, createSessionOpenCommand } from '../../renderer/features/session-navigation/testing.js';
import type { DesktopSessionSummary } from '../../shared/desktop-session-projection.js';

const cleanups: Array<() => void> = [];
afterEach(() => { cleanupFakeDom(); while (cleanups.length) cleanups.pop()!(); });

function setup() {
  const { root } = installReactRenderer();
  const body = new FakeElement('body', document);
  Object.defineProperty(document, 'body', { value: body });
  const dom = parseHTML('<html><body><main data-session-history-surface><p>Conversation</p><textarea></textarea><div class="scroller"><pre>wide code</pre></div></main><aside>Terminal</aside></body></html>');
  dom.document.querySelector('main')!.getBoundingClientRect = () => ({ left: 100, right: 700, top: 50, height: 400 }) as DOMRect;
  for (const [key, value] of Object.entries({
    Element: dom.window.Element,
    getComputedStyle: () => ({ overflowX: 'visible' }),
  })) {
    const prior = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    cleanups.push(() => { if (prior) Object.defineProperty(globalThis, key, prior); else Reflect.deleteProperty(globalThis, key); });
  }
  const listeners = new Set<EventListener>();
  const blurListeners = new Set<EventListener>();
  window.addEventListener = ((name: string, listener: EventListener) => {
    if (name === 'blur') blurListeners.add(listener);
  }) as typeof window.addEventListener;
  window.removeEventListener = ((name: string, listener: EventListener) => {
    if (name === 'blur') blurListeners.delete(listener);
  }) as typeof window.removeEventListener;
  document.addEventListener = ((name: string, listener: EventListener) => {
    if (name === 'wheel') listeners.add(listener);
  }) as typeof document.addEventListener;
  document.removeEventListener = ((name: string, listener: EventListener) => {
    if (name === 'wheel') listeners.delete(listener);
  }) as typeof document.removeEventListener;
  const catalog = createSessionCatalogController();
  catalog.commitSessions(['A', 'B', 'C', 'D'].map((id): DesktopSessionSummary => ({
    id, name: id, isFlagged: false, isArchived: false, labels: [], hasUnread: false,
    status: 'active', backend: 'fake', llmConnectionSlug: 'test', connectionLocked: true,
    model: 'test', permissionMode: 'ask', profileId: 'local', profileName: 'Local',
    profileKind: 'local', runtimeHostId: 'local-host', revision: 0, activityAt: 0,
  })));
  const targets: unknown[] = [];
  const openSession = createSessionOpenCommand({
    activateSession: catalog.setActiveSessionId,
    exitWorkHub() {}, selectSessionSurface() {},
    setSearchTarget: (target) => targets.push(target),
  });
  const render = (visible = true, blocked = false) => act(() => root.render(createElement(
    SessionHistoryNavigation, { catalog, visible, blocked, openSession },
  )));
  render();
  const wheel = (timeStamp: number, overrides: Partial<WheelEvent> = {}, selector = 'p') => {
    const target = dom.document.querySelector(selector)!;
    const path: EventTarget[] = [];
    for (let node: Element | null = target; node; node = node.parentElement) path.push(node);
    let prevented = false;
    const event = {
      deltaX: -100, deltaY: 0, deltaMode: 0, timeStamp, cancelable: true, defaultPrevented: false,
      ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
      composedPath: () => path, preventDefault: () => { prevented = true; }, ...overrides,
    } as WheelEvent;
    act(() => { for (const listener of listeners) listener(event); });
    return prevented;
  };
  const feedback = () => body.childNodes[0] as FakeElement | undefined;
  const blur = () => act(() => { for (const listener of blurListeners) listener(new Event('blur')); });
  return { catalog, root, render, wheel, targets, dom, listeners, feedback, blur, blurListeners };
}

it('shows pull progress before switching and acknowledges the threshold only once', () => {
  const { catalog, wheel, feedback, targets } = setup();
  for (const id of ['A', 'B', 'C']) catalog.setActiveSessionId(id);
  wheel(0, { deltaX: -24 });
  assert.equal(catalog.getState().activeSessionId, 'C');
  assert.equal(feedback()?.getAttribute('data-phase'), 'pulling');
  assert.equal(String(feedback()?.getAttribute('data-progress')), '0.3');
  wheel(16, { deltaX: -56 });
  assert.equal(catalog.getState().activeSessionId, 'B');
  assert.equal(feedback()?.getAttribute('data-phase'), 'committed');
  wheel(32);
  assert.deepEqual(targets, [null]);
});

it('retracts an unfinished pull after idle and removes the feedback without navigating', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { catalog, wheel, feedback } = setup();
  for (const id of ['A', 'B']) catalog.setActiveSessionId(id);
  wheel(0, { deltaX: -32 });
  act(() => t.mock.timers.tick(250));
  assert.equal(feedback()?.getAttribute('data-phase'), 'returning');
  act(() => t.mock.timers.tick(180));
  assert.equal(feedback(), undefined);
  assert.equal(catalog.getState().activeSessionId, 'B');
});

it('shows unavailable feedback at the history boundary instead of acknowledging a move', () => {
  const { catalog, wheel, feedback, targets } = setup();
  catalog.setActiveSessionId('A');
  wheel(0, { deltaX: -32 });
  assert.equal(feedback()?.getAttribute('data-phase'), 'unavailable');
  wheel(16);
  assert.equal(feedback()?.getAttribute('data-phase'), 'unavailable');
  assert.deepEqual(targets, []);
});

it('cancels feedback and the gesture when a modal interrupts a pull', () => {
  const { catalog, wheel, feedback, render } = setup();
  for (const id of ['A', 'B']) catalog.setActiveSessionId(id);
  wheel(0, { deltaX: -32 });
  render(true, true);
  assert.equal(feedback(), undefined);
  render();
  assert.equal(feedback() === undefined, true);
  wheel(16, { deltaX: -60 });
  assert.equal(catalog.getState().activeSessionId, 'B');
  wheel(400);
  assert.equal(catalog.getState().activeSessionId, 'A');
});

it('removes an in-progress arrow when the pointer enters an excluded control', () => {
  const { catalog, wheel, feedback } = setup();
  for (const id of ['A', 'B']) catalog.setActiveSessionId(id);
  wheel(0, { deltaX: -32 });
  wheel(16, { deltaX: -20 }, 'textarea');
  assert.equal(feedback() === undefined, true);
  wheel(32);
  assert.equal(catalog.getState().activeSessionId, 'B');
});

it('cancels a pull on window blur and releases listeners and timers on unmount', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { catalog, wheel, feedback, blur, root, blurListeners } = setup();
  for (const id of ['A', 'B']) catalog.setActiveSessionId(id);
  wheel(0, { deltaX: -32 });
  blur();
  assert.equal(feedback() === undefined, true);
  wheel(16);
  assert.equal(catalog.getState().activeSessionId, 'B');
  wheel(400, { deltaX: -32 });
  act(() => root.render(null));
  act(() => t.mock.timers.tick(1000));
  assert.equal(feedback() === undefined, true);
  assert.equal(blurListeners.size, 0);
});

it('records rapid requested selections and traverses them through the existing open command', () => {
  const { catalog, render, wheel, targets } = setup();
  act(() => { for (const id of ['A', 'C', 'B']) catalog.setActiveSessionId(id); });
  assert.equal(wheel(0), true);
  assert.equal(catalog.getState().activeSessionId, 'C');
  render(); // A React commit acknowledging the traversal must not branch history.
  wheel(16);
  assert.equal(catalog.getState().activeSessionId, 'C');
  wheel(400);
  assert.equal(catalog.getState().activeSessionId, 'A');
  wheel(800, { deltaX: 100 });
  assert.equal(catalog.getState().activeSessionId, 'C');
  assert.deepEqual(targets, [null, null, null]);
});

it('ignores settings, modal, non-conversation, edited-text, zoom and non-pixel input', () => {
  const { catalog, render, wheel } = setup();
  catalog.setActiveSessionId('A'); catalog.setActiveSessionId('B');
  render(false);
  assert.equal(wheel(0), false);
  render(true, true);
  assert.equal(wheel(400), false);
  render();
  assert.equal(wheel(800, {}, 'aside'), false);
  assert.equal(wheel(1200, {}, 'textarea'), false);
  assert.equal(wheel(1600, { ctrlKey: true }), false);
  assert.equal(wheel(2000, { deltaMode: 1 }), false);
  assert.equal(wheel(2400, { shiftKey: true }), false);
  assert.equal(wheel(2800, { defaultPrevented: true }), false);
  assert.equal(catalog.getState().activeSessionId, 'B');
  wheel(3200);
  assert.equal(catalog.getState().activeSessionId, 'A');
});

it('keeps horizontal overflow gestures with their content even at the scroll edge', () => {
  const { catalog, dom, wheel } = setup();
  catalog.setActiveSessionId('A'); catalog.setActiveSessionId('B');
  const scroller = dom.document.querySelector('.scroller')!;
  Object.defineProperties(scroller, { clientWidth: { value: 200 }, scrollWidth: { value: 600 }, scrollLeft: { value: 0 } });
  globalThis.getComputedStyle = ((element: Element) => ({ overflowX: element === scroller ? 'auto' : 'visible' })) as typeof getComputedStyle;
  assert.equal(wheel(0, {}, 'pre'), false);
  assert.equal(wheel(16), false); // Moving the pointer outside does not steal the tail.
  assert.equal(catalog.getState().activeSessionId, 'B');
  wheel(400);
  assert.equal(catalog.getState().activeSessionId, 'A');
});

it('skips a missing catalog row but keeps its visit when the row returns', () => {
  const { catalog, wheel } = setup();
  const sessions = catalog.getState().sessions;
  for (const id of ['A', 'B', 'C']) catalog.setActiveSessionId(id);
  catalog.commitSessions(sessions.filter((session) => session.id !== 'B'));
  wheel(0);
  assert.equal(catalog.getState().activeSessionId, 'A');
  catalog.commitSessions(sessions);
  wheel(400, { deltaX: 100 });
  assert.equal(catalog.getState().activeSessionId, 'B');
});

it('does not retain event listeners after unmount', () => {
  const { root, listeners } = setup();
  assert.equal(listeners.size, 1);
  act(() => root.render(null));
  assert.equal(listeners.size, 0);
});

it('does not resurrect a confirmed removed visit during an unrelated React commit', () => {
  const { catalog, render, wheel } = setup();
  const removed = catalog.getState().sessions.find((session) => session.id === 'C')!;
  for (const id of ['A', 'B', 'C']) catalog.setActiveSessionId(id);
  catalog.commitPatch('C', null);
  render();
  wheel(0);
  assert.equal(catalog.getState().activeSessionId, 'B');
  catalog.commitPatch('C', removed);
  wheel(400, { deltaX: 100 });
  assert.equal(catalog.getState().activeSessionId, 'B');
});
