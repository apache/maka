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

/** Browser layout corrections do not create a reader operation. */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { createTranscriptScrollAuthority } from '../src/transcript-scroll-authority.js';

const SCROLLER_ID = 'intent-probe-scroller';

function Scroller() {
  return (
    <div
      id={SCROLLER_ID}
      style={{ height: '300.5px', overflowY: 'auto', border: '1px solid #ccc' }}
    >
      <div data-probe="above" style={{ height: '400.5px', background: '#eef' }} />
      <div data-probe="anchor" style={{ height: '120.5px', background: '#efe' }}>
        anchor
      </div>
      <div data-probe="below" style={{ height: '900.5px', background: '#fee' }} />
    </div>
  );
}

const meta = {
  title: 'Product/Transcript Scroll Intent',
  component: Scroller,
} satisfies Meta<typeof Scroller>;

export default meta;
type Story = StoryObj<typeof meta>;

function scroller(): HTMLElement {
  const root = document.getElementById(SCROLLER_ID);
  if (!root) throw new Error('the probe scroller is missing');
  return root;
}

function settled(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

// A browser probe for native anchoring/clamping; fake DOM geometry cannot
// establish that those operations leave reader intent alone.
export const LayoutDoesNotCreateReaderIntent: Story = {
  play: async () => {
    const root = scroller();
    const above = root.querySelector<HTMLElement>('[data-probe="above"]')!;
    const below = root.querySelector<HTMLElement>('[data-probe="below"]')!;
    const authority = createTranscriptScrollAuthority();
    const detach = authority.attach(root);
    try {
      authority.releasePin();
      root.scrollTop = root.scrollHeight - root.clientHeight - 30;
      await settled();
      let readerMoves = 0;
      authority.subscribeToReaderScroll((phase) => {
        if (phase === 'scroll') readerMoves += 1;
      });
      above.style.height = '407.8px';
      await settled();
      below.style.height = '800.2px';
      await settled();
      await expect(readerMoves).toBe(0);
      await expect(authority.getSnapshot().pinned).toBe(false);

      root.dispatchEvent(new WheelEvent('wheel', { deltaY: -2, bubbles: true }));
      root.scrollTop -= 2;
      await settled();
      await expect(readerMoves).toBe(1);
    } finally {
      detach();
    }
  },
};

// Growth can replace intrinsic-size estimates above the viewport while adding
// content below it. A queued tail-write event must not turn that layout into
// reader intent just because its net height change has the opposite sign.
export const OpposingResizesKeepFollowingTheTail: Story = {
  play: async () => {
    const root = scroller();
    const above = root.querySelector<HTMLElement>('[data-probe="above"]');
    const below = root.querySelector<HTMLElement>('[data-probe="below"]');
    if (!above || !below) throw new Error('the probe spacers are missing');
    const anchor = root.querySelector<HTMLElement>('[data-probe="anchor"]');
    if (!anchor) throw new Error('the probe anchor is missing');
    // Keep the anchor visible above the tail spacer so native anchoring has
    // a candidate whose position changes when the upper box shrinks.
    root.style.height = '860px';
    above.style.height = '2000px';
    anchor.style.height = '1000px';
    below.style.height = '600px';
    const authority = createTranscriptScrollAuthority();
    const detach = authority.attach(root);
    try {
      await settled();
      // Leave the rAF callback: mutations made inside it are observed by RO
      // in that same rendering step, before a pending scroll can be delivered.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      let readerMoves = 0;
      authority.subscribeToReaderScroll(() => { readerMoves += 1; });

      const previousHeight = root.scrollHeight;
      // Queue a real scroll event from a tail write. Before it arrives, layout
      // shrinks above the reader and grows below them in the same task.
      below.style.height = '601px';
      authority.pinToTail();
      above.style.height = '1909px';
      below.style.height = '1200px';
      // Commit layout before the queued scroll event is delivered. This is
      // also what a consumer reading scrollHeight during streaming does.
      expect(root.scrollHeight).toBeGreaterThan(previousHeight);
      await settled();

      expect(readerMoves).toBe(0);
      expect(authority.getSnapshot().pinned).toBe(true);
      expect(root.scrollHeight - root.clientHeight - root.scrollTop).toBeLessThanOrEqual(4);
    } finally {
      detach();
    }
  },
};
