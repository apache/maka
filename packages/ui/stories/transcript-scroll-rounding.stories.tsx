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

/**
 * The one claim in `TranscriptScrollAuthority` a fake DOM cannot make.
 *
 * It decides the reader moved by measuring the offset against what the content
 * accounts for, and it reads those from two different number systems: CSSOM
 * gives `scrollTop` as a double and `scrollHeight` / `clientHeight` as longs.
 * So the comparison holds an exact number against rounded ones, and the
 * `packages/ui` suite — a fake DOM of integers — cannot put a fraction into it.
 *
 * It is measured here instead, in a real layout engine on fractional heights,
 * through both paths that move the offset without the reader: native anchoring
 * compensating content above them, and the browser clamping the offset when
 * the transcript ends before it. Clamping lands exact. Anchoring misses, which
 * is where `GEOMETRY_ROUNDING_PX` comes from — it is that measurement, and
 * this is the thing that holds it.
 *
 * And it holds the other half of the rule, which is that the slack is spent
 * only on events the content actually moved. A settled transcript rounds
 * nothing, so a reader inching down one is heard exactly; that is the last
 * phase, and it is what a slack applied unconditionally would swallow.
 *
 * It asks the authority directly rather than reading a scroll position. A
 * misclassification while the reader is at the tail re-derives the same pin and
 * moves nothing, so position is exactly the observable that cannot see this;
 * `subscribeToReaderScroll` is the module's own answer to "was that the
 * reader", which is the question.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { createTranscriptScrollAuthority } from '../src/transcript-scroll-authority.js';

const SCROLLER_ID = 'rounding-probe-scroller';

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
  title: 'Product/Transcript Scroll Rounding',
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

// Real path: none — this is a probe, and it says so. The surface it guards is
// every streaming transcript; what it needs from a browser is fractional box
// heights and CSSOM's two number systems, which no product state adds to it.
export const ContentThatOnlyRoundsIsNotTheReader: Story = {
  play: async () => {
    const root = scroller();
    const above = root.querySelector<HTMLElement>('[data-probe="above"]');
    const below = root.querySelector<HTMLElement>('[data-probe="below"]');
    if (!above || !below) throw new Error('the probe spacers are missing');

    const authority = createTranscriptScrollAuthority();
    const detach = authority.attach(root);
    try {
      // Released, so the authority writes nothing and every offset change
      // below is the browser's alone. Far enough off the tail that a misread
      // cannot be laundered by re-deriving the same pinned answer, but close
      // enough that content leaving from underneath reaches them in a few
      // steps.
      authority.releasePin();
      root.scrollTop = root.scrollHeight - root.clientHeight - 30;
      await settled();

      let readerMoves = 0;
      authority.subscribeToReaderScroll(() => {
        readerMoves += 1;
      });

      // Fractional content change, crossing a rounding boundary on every step,
      // through both paths that move the offset without the reader. Growth
      // above them is answered by native anchoring, which pushes the offset
      // down by what it inserted. Content taken from under them eventually
      // ends the transcript in front of the offset, and the browser pulls the
      // offset back to that end — the end it holds itself, while the authority
      // reads it as `scrollHeight - clientHeight`, two integers each rounded
      // on its own.
      const escapes: number[] = [];
      const record = async (change: () => void): Promise<void> => {
        const beforeTop = root.scrollTop;
        const beforeRange = root.scrollHeight - root.clientHeight;
        change();
        await settled();
        const contentDelta = root.scrollHeight - root.clientHeight - beforeRange;
        const topDelta = root.scrollTop - beforeTop;
        const low = Math.min(0, contentDelta);
        const high = Math.max(0, contentDelta);
        escapes.push(topDelta - Math.min(high, Math.max(low, topDelta)));
      };

      let aboveHeight = 400.5;
      for (let step = 0; step < 40; step += 1) {
        await record(() => {
          aboveHeight += 7.3;
          above.style.height = `${aboveHeight}px`;
        });
      }
      let belowHeight = 900.5;
      for (let step = 0; step < 40; step += 1) {
        await record(() => {
          belowHeight -= 7.3;
          below.style.height = `${belowHeight}px`;
        });
      }

      // What the arithmetic missed by, which is what the constant has to
      // cover. Recorded rather than merely tolerated: if a browser starts
      // missing by more, the number in the module is stale and this says so
      // here, instead of the transcript quietly deciding a streaming answer's
      // reader had reached for the scrollbar.
      const worst = Math.max(...escapes.map(Math.abs));
      await expect(
        worst,
        `content moved the offset further outside its own band than the module allows; escapes ${escapes
          .map((value) => value.toExponential(2))
          .join(' ')}`,
      ).toBeLessThanOrEqual(2);

      // And none of it was read as the reader, who touched nothing at all.
      await expect(
        readerMoves,
        `content the browser moved under the reader was read as a gesture; escapes ${escapes
          .map((value) => value.toExponential(2))
          .join(' ')}`,
      ).toBe(0);

      // And the run is only worth anything if this classifier still says yes
      // to a reader. Two pixels, on content that just settled: no arithmetic
      // happened, so nothing here is owed any slack, and a version that spent
      // it anyway would lose this reader — the same reader, moving the same
      // way, that a streaming transcript has to keep.
      root.scrollTop -= 2;
      await settled();
      await expect(readerMoves, 'a reader on settled content went unheard').toBe(1);
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
