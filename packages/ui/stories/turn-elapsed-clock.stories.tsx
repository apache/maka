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

import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { StoredMessage } from '@maka/core/session';
import { ProcessingBlock, TurnView } from '../src/chat-turn.js';
import { useUiLocale } from '../src/locale-context.js';
import { applyLiveTurnEvent, armLiveTurn } from '../src/live-turn-projection.js';
import { materializeTurns, overlayLiveTurn } from '../src/materialize.js';

// Fidelity convention (#1433): the desktop transcript reaches this path
// through app-shell live events → overlayLiveTurn → TurnView, which is what
// the harness below reproduces with the same public functions.

const TURN_ID = 'turn-elapsed-clock';
const RUNNING_FOR_MS = 213_000;
// The Turn really started earlier than the client's first live event: only a
// gap between the two can tell a stable stand-in start from the recorded one.
const DURABLE_RUNNING_FOR_MS = 333_000;
// Each tool reads a different file: two identical rows would be ambiguous to a
// screen reader.
function toolAt(index: number) {
  return {
    toolUseId: `tool-${index}`,
    toolName: index % 2 === 0 ? 'Read' : 'Grep',
    path: `docs/step-${index}.md`,
  };
}

// What the transcript carries once it reaches this running Turn: the Host's
// own record of when it started.
function durableTurnMessages(startedAt: number): StoredMessage[] {
  return [
    { type: 'user', id: 'durable-user', turnId: TURN_ID, ts: startedAt, text: '查一下仓库里的用法' },
    { type: 'turn_state', id: 'durable-state', turnId: TURN_ID, ts: startedAt, status: 'running' },
  ];
}

function RunningTurn() {
  const locale = useUiLocale();
  // The Turn began before the transcript reached it — the case where the
  // renderer has no durable row to take a start from.
  const [startedAt] = useState(() => Date.now() - RUNNING_FOR_MS);
  const [projection, setProjection] = useState(() =>
    applyLiveTurnEvent(armLiveTurn(TURN_ID), {
      type: 'text_delta',
      id: 'event-start',
      turnId: TURN_ID,
      messageId: 'step-1',
      ts: startedAt,
      text: '正在查阅仓库…',
    }, locale),
  );
  const [started, setStarted] = useState(0);
  const [durable, setDurable] = useState<readonly StoredMessage[]>([]);
  const turn = overlayLiveTurn(materializeTurns(durable, locale), projection, locale)[0];

  return (
    <section style={{ display: 'grid', gap: 16, maxWidth: 760 }}>
      <button
        type="button"
        onClick={() => setDurable(durableTurnMessages(Date.now() - DURABLE_RUNNING_FOR_MS))}
      >
        持久化记录到达 / durable record arrives
      </button>
      <button
        type="button"
        onClick={() => {
          const tool = toolAt(started);
          setStarted(started + 1);
          setProjection((current) =>
            applyLiveTurnEvent(current, {
              type: 'tool_start',
              id: `event-${tool.toolUseId}`,
              turnId: TURN_ID,
              stepId: `step-${tool.toolUseId}`,
              toolUseId: tool.toolUseId,
              toolName: tool.toolName,
              args: { path: tool.path },
              ts: Date.now(),
            }, locale),
          );
        }}
      >
        新工具事件 / next tool event
      </button>
      {turn && <TurnView turn={turn} liveStreaming={{ runningStatus: true }} />}
    </section>
  );
}

const meta = {
  title: 'Product/Turn Elapsed Clock',
  component: RunningTurn,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof RunningTurn>;

export default meta;
type Story = StoryObj<typeof meta>;

function elapsedSeconds(canvasElement: HTMLElement): number {
  const label = canvasElement.querySelector('.maka-turn-elapsed')?.textContent ?? '';
  const [, minutes, seconds] = /(?:(\d+)m\s*)?(\d+)s/.exec(label) ?? [];
  if (seconds === undefined) throw new Error(`the elapsed clock reads "${label}"`);
  return Number(minutes ?? 0) * 60 + Number(seconds);
}

// #5365: the clock measures one Turn, so each new tool must leave it running
// from the Turn's first event. It reset to zero while the running Turn was
// missing from the transcript and the renderer stamped `Date.now()` instead.
export const KeepsRunningAcrossTools: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(elapsedSeconds(canvasElement)).toBeGreaterThanOrEqual(213));

    for (const index of [0, 1]) {
      await userEvent.click(canvas.getByRole('button', { name: /next tool event/ }));
      await canvas.findAllByText(new RegExp(toolAt(index).path));
      await expect(elapsedSeconds(canvasElement)).toBeGreaterThanOrEqual(213);
    }
  },
};

// #5365: the live start is only a stand-in until the transcript reaches the
// Turn. Once the Host's own record arrives the clock has to adopt its start —
// correcting upward for the time that ran before the client subscribed — and
// keep it across later events rather than falling back to the stand-in.
export const AdoptsTheRecordedStart: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(elapsedSeconds(canvasElement)).toBeGreaterThanOrEqual(213));
    await expect(elapsedSeconds(canvasElement)).toBeLessThan(333);

    await userEvent.click(canvas.getByRole('button', { name: /durable record arrives/ }));
    await waitFor(() => expect(elapsedSeconds(canvasElement)).toBeGreaterThanOrEqual(333));

    for (const index of [0, 1]) {
      await userEvent.click(canvas.getByRole('button', { name: /next tool event/ }));
      await canvas.findAllByText(new RegExp(toolAt(index).path));
      await expect(elapsedSeconds(canvasElement)).toBeGreaterThanOrEqual(333);
    }
  },
};

// The same Turn once it settles: the duration is copy, not a clock, and the
// zh number needs a space before its unit.
export const SettledDuration: Story = {
  render: () => <ProcessingBlock entries={[]} running={false} durationMs={RUNNING_FOR_MS} />,
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('.maka-processing-summary')).toHaveTextContent(
      '用时 3 分 33 秒',
    );
  },
};
