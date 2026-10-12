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
import { expect, userEvent, waitFor } from 'storybook/test';
import { TurnView } from '../src/chat-turn.js';
import type { TurnViewModel } from '../src/materialize.js';

// Real path: regenerating a turn keeps both turns; the renderer's
// derive-turn-lineage-badges produces one badge per direction and hands them
// to TurnView through `lineageBadges` together with `footerActions` —
// the same props this fixture uses. The labels below are the zh-CN copy
// strings those helpers emit.

const TURN: TurnViewModel = {
  turnId: 'turn-lineage',
  status: 'completed',
  statusSource: 'recorded',
  tools: [],
  notes: [],
  startedAt: Date.UTC(2026, 8, 19, 9, 0),
  durationMs: 47_000,
  timeline: [
    { kind: 'user', messageId: 'u-1', message: { id: 'u-1', role: 'user', text: '把摘要再写一版', ts: Date.UTC(2026, 8, 19, 9, 0) } },
    { kind: 'text', messageId: 'a-1', text: '这是重新生成后的回答正文。' },
  ],
};

const noop = () => undefined;

function LineageTurn() {
  return (
    <section style={{ display: 'grid', gap: 16, maxWidth: 760 }}>
      <TurnView
        turn={TURN}
        lineageBadges={[
          {
            id: 'forward-regen',
            label: '重新生成自旧回答',
            tooltip: '这是重新生成的并行回答，点击查看被保留的旧回答',
            targetTurnId: 'turn-lineage-origin',
            direction: 'forward',
          },
          {
            id: 'reverse-regen',
            label: '已重新生成 → 新回答',
            tooltip: '点击跳转到重新生成的新回答',
            targetTurnId: 'turn-lineage-next',
            direction: 'reverse',
          },
        ]}
        onLineageBadgeClick={noop}
        footerActions={[
          { id: 'branch', label: '分支', enabled: true },
          { id: 'copy', label: '复制', enabled: true, tooltip: '复制回答' },
        ]}
        onFooterAction={noop}
      />
    </section>
  );
}

const meta = {
  title: 'Product/Turn Lineage',
  component: LineageTurn,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof LineageTurn>;

export default meta;
type Story = StoryObj<typeof meta>;

// The forward row sits above the prompt, the reverse row under the answer,
// and the footer toolbar stays pointer-hidden until focus lands inside it —
// same resting/reveal contract the transcript relies on.
export const BothDirections: Story = {
  play: async ({ canvasElement }) => {
    const forward = canvasElement.querySelector<HTMLElement>(
      '.maka-turn-lineage-row .astryx-button[data-direction="forward"]',
    );
    const reverse = canvasElement.querySelector<HTMLElement>(
      '.maka-turn-lineage-row-reverse .astryx-button[data-direction="reverse"]',
    );
    await expect(forward).not.toBeNull();
    await expect(reverse).not.toBeNull();
    // The pill reaches the badge through the row's `--_button-radius`
    // inherit; pin it so a silent upstream rename of the derived var fails
    // here instead of only in a pixel run.
    await expect(getComputedStyle(forward!).borderRadius).toBe('999px');

    const footer = canvasElement.querySelector<HTMLElement>('.maka-turn-footer')!;
    await expect(footer).not.toBeNull();
    // Script focus() alone does not paint :focus-visible; tab off the reverse
    // badge so the footer buttons carry real keyboard rings and the footer's
    // :focus-within reveal fires. Branch sits first, copy second — land on
    // branch so the ring is on the row's left edge.
    reverse!.focus();
    await userEvent.tab();
    const branch = footer.querySelector('button')!;
    await waitFor(() => expect(canvasElement.ownerDocument.activeElement).toBe(branch));
    await waitFor(() => expect(getComputedStyle(footer).opacity).toBe('1'));
    // The ring is the component's own outline pulled inside the border box by
    // the footer's `--focus-outline-offset` retune — the mechanism the T5
    // probe needed, minus the product shadow repaint.
    await expect(getComputedStyle(branch).outlineOffset).toBe('-2px');
  },
};
