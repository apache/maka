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

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useState, useSyncExternalStore } from 'react';
import { ChatSurfaceLayout, MarkdownBody } from '@maka/ui';
import { createSessionCatalogController } from '../src/renderer/application/contracts/session-catalog/session-catalog-state.js';
import { SessionHistoryNavigation, createSessionOpenCommand } from '../src/renderer/features/session-navigation/index.js';
import type { DesktopSessionSummary } from '../src/shared/desktop-session-projection.js';

const meta = { title: 'Primitives/Session History Navigation' } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function HistoryInputFixture() {
  const [catalog] = useState(() => {
    const controller = createSessionCatalogController();
    controller.commitSessions(['A', 'B', 'C'].map((id): DesktopSessionSummary => ({
      id, name: id, isFlagged: false, isArchived: false, labels: [], hasUnread: false,
      status: 'active', backend: 'fake', llmConnectionSlug: 'test', connectionLocked: true,
      model: 'test', permissionMode: 'ask', profileId: 'local', profileName: 'Local',
      profileKind: 'local', runtimeHostId: 'local-host', revision: 0, activityAt: 0,
    })));
    controller.setActiveSessionId('A');
    return controller;
  });
  const state = useSyncExternalStore(catalog.subscribe, catalog.getState);
  const [open] = useState(() => createSessionOpenCommand({
    activateSession: catalog.setActiveSessionId, exitWorkHub() {},
    selectSessionSurface() {}, setSearchTarget() {},
  }));
  return <>
    <SessionHistoryNavigation catalog={catalog} visible blocked={false} openSession={open} />
    <nav aria-label="Test session selection">
      {['A', 'B', 'C'].map((id) => <button key={id} onClick={() => open(id)}>Open {id}</button>)}
    </nav>
    <output aria-label="Selected session">{state.activeSessionId}</output>
    {/* Input fixture, not another product shell: real ChatSurfaceLayout owns
        the surface marker and MarkdownBody owns horizontal code scrolling. */}
    <div style={{ height: 420, width: 600, display: 'flex', flexDirection: 'column' }}>
      <ChatSurfaceLayout data-session-history-surface="true" composer={<textarea aria-label="Draft input" />}>
        <p data-testid="history-swipe-prose">Swipe here to navigate session visits.</p>
        <MarkdownBody text={'```text\n' + 'wide code '.repeat(100) + '\n```'} />
      </ChatSurfaceLayout>
    </div>
  </>;
}

// Real path: A → C → B, then swipe over conversation prose or a wide code block.
// This fixture verifies Chromium event propagation and actual overflow geometry;
// the catalog, navigation command and wheel listener are the production ones.
export const HorizontalScrollOwnership: Story = {
  render: () => <HistoryInputFixture />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Open C' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Open B' }));
    const selected = canvas.getByLabelText('Selected session');
    const prose = canvas.getByTestId('history-swipe-prose');
    const code = await waitFor(() => {
      const code = canvasElement.querySelector('pre code');
      expect(code).not.toBeNull();
      return code!;
    });
    let overflow: Element | null = code;
    while (overflow && !(overflow.scrollWidth > overflow.clientWidth + 1 && /^(auto|scroll)$/.test(getComputedStyle(overflow).overflowX))) {
      overflow = overflow.parentElement;
    }
    expect(overflow, 'The real code block must have horizontal overflow').not.toBeNull();
    // Synthetic timestamps control gesture boundaries, not render completion.
    const wheel = (target: Element, timeStamp: number, deltaX = -100, cancelable = true, point?: { clientX: number; clientY: number }) => {
      const event = new WheelEvent('wheel', { deltaX, bubbles: true, cancelable, ...point });
      Object.defineProperty(event, 'timeStamp', { value: timeStamp });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(wheel(code, 0)).toBe(false);
    expect(wheel(prose, 16)).toBe(false);
    expect(selected).toHaveTextContent('B');
    expect(wheel(prose, 400, -32)).toBe(true);
    const indicator = await waitFor(() => {
      const element = canvasElement.ownerDocument.querySelector('.session-history-swipe')!;
      expect(element).not.toBeNull();
      expect(element).toHaveAttribute('data-phase', 'pulling');
      expect(element).toHaveAttribute('data-progress', '0.4');
      return element;
    });
    expect(selected).toHaveTextContent('B');
    expect(getComputedStyle(indicator).pointerEvents).toBe('none');
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      expect(getComputedStyle(indicator).transitionDuration).toBe('0.18s, 0.2s');
    }
    expect((indicator as HTMLElement).offsetHeight).toBe(104);
    expect(getComputedStyle(indicator.querySelector('svg')!).strokeWidth).toBe('3px');
    const surface = prose.closest('[data-session-history-surface]')!.getBoundingClientRect();
    const arrow = indicator.getBoundingClientRect();
    expect(Math.abs(arrow.left - surface.left)).toBeLessThan(1);
    expect(arrow.right).toBeLessThan(surface.right);
    expect(Math.abs((arrow.top + arrow.bottom) / 2 - (surface.top + surface.bottom) / 2)).toBeLessThan(1);
    expect(wheel(prose, 416, -48)).toBe(true);
    await waitFor(() => expect(selected).toHaveTextContent('C'));
    await waitFor(() => expect(indicator).toHaveAttribute('data-phase', 'committed'));
    wheel(prose, 432);
    expect(selected).toHaveTextContent('C');
    wheel(prose, 800, 100);
    await waitFor(() => expect(selected).toHaveTextContent('B'));
    await waitFor(() => {
      const forward = canvasElement.ownerDocument.querySelector('.session-history-swipe')!;
      expect(forward).toHaveAttribute('data-direction', '1');
      expect(Math.abs(forward.getBoundingClientRect().right - surface.right)).toBeLessThan(1);
    });
    const draft = canvas.getByRole('textbox', { name: 'Draft input' });
    await userEvent.type(draft, 'unsent text');
    expect(wheel(draft, 1200)).toBe(false);
    expect(draft).toHaveValue('unsent text');
    expect(selected).toHaveTextContent('B');
    await waitFor(() => expect(canvasElement.ownerDocument.querySelector('.session-history-swipe')).toBeNull());
    // The Windows capture starts tiny and only its first frame is cancelable.
    wheel(prose, 1600, -1.6667);
    expect(wheel(prose, 1603.2, -6.6667, false)).toBe(false);
    expect(wheel(prose, 1625.5, -21.6667, false)).toBe(false);
    await waitFor(() => expect(canvasElement.ownerDocument.querySelector('.session-history-swipe')).toHaveAttribute('data-phase', 'pulling'));
    wheel(prose, 1746.6, -201.6667, false);
    await waitFor(() => expect(selected).toHaveTextContent('C'));
    // Keep the original final Session for the native wheel smoke that follows.
    wheel(prose, 2100, 100);
    await waitFor(() => expect(selected).toHaveTextContent('B'));
    await waitFor(() => expect(canvasElement.ownerDocument.querySelector('.session-history-swipe')).toHaveAttribute('data-phase', 'returning'));
    const returning = canvasElement.ownerDocument.querySelector('.session-history-swipe')!;
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      expect(getComputedStyle(returning).transitionDuration.split(',')[0]).toBe('0.42s');
    }
    await waitFor(() => expect(canvasElement.ownerDocument.querySelector('.session-history-swipe')).toBeNull());
    // Session replacement makes the main column inert. Chromium hits its
    // ancestor, which can remain the wheel target after loading completes.
    const layout = prose.closest<HTMLElement>('[data-session-history-surface]')!;
    const rect = prose.getBoundingClientRect();
    const point = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    layout.inert = true;
    const latchedTarget = document.elementFromPoint(point.clientX, point.clientY)!;
    expect(latchedTarget.contains(layout)).toBe(true);
    wheel(latchedTarget, 2600, -30, true, point);
    expect(selected).toHaveTextContent('B');
    layout.inert = false;
    wheel(latchedTarget, 2630, -90, false, point);
    await waitFor(() => expect(selected).toHaveTextContent('C'));
    const fast = canvasElement.ownerDocument.querySelector('.session-history-swipe')!;
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      expect(getComputedStyle(fast).transitionDuration).toBe('0.28s, 0.3s');
    }
    // Live hit-testing must retain the original editor/overflow exclusions.
    for (const target of [draft, code]) {
      const r = target.getBoundingClientRect();
      expect(wheel(latchedTarget, target === draft ? 3100 : 3500, 100, true,
        { clientX: r.left + 2, clientY: r.top + 2 })).toBe(false);
      expect(selected).toHaveTextContent('C');
    }
    wheel(prose, 3900, 100);
    await waitFor(() => expect(selected).toHaveTextContent('B'));
    await waitFor(() => expect(canvasElement.ownerDocument.querySelector('.session-history-swipe')).toBeNull());
  },
};
