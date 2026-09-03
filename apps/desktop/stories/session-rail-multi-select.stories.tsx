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
 * The rail with more than one task picked.
 *
 * Lives here rather than beside the other rail stories in `packages/ui`
 * because the selection is the app's: `useSessionSelection` and the reducer
 * under it are desktop-side, and a story that reimplemented them would be
 * showing its own behaviour rather than the product's. What it renders is the
 * real `SessionListPanel`, through the same harness the other rail stories use.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { SessionSummary } from '@maka/core/session';
import { SessionRail } from '../../../packages/ui/stories/session-rail-harness.js';
import {
  useSessionSelection,
  type SessionNavigationRowActions,
} from '../src/renderer/features/session-navigation/testing';

const NOW = Date.now();
const noop = () => undefined;

// Fidelity convention (#1433): every story below names the real app path
// that reaches it. See apps/desktop/stories/FIDELITY.md.

const meta = {
  title: 'Product/Sidebar Multi Select',
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function makeSession(input: {
  id: string;
  name: string;
  minutesAgo: number;
  isFlagged?: boolean;
}): SessionSummary {
  return {
    id: input.id,
    name: input.name,
    isFlagged: input.isFlagged ?? false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    lastMessageAt: NOW - input.minutesAgo * 60 * 1000,
    backend: 'ai-sdk',
    llmConnectionSlug: 'zai-live',
    connectionLocked: false,
    model: 'glm-4.7',
    permissionMode: 'ask',
  };
}

const SESSIONS = [
  makeSession({ id: 'rail-a', name: '发布风险清单', minutesAgo: 8 }),
  makeSession({ id: 'rail-b', name: '整理 compact controls', minutesAgo: 21 }),
  makeSession({ id: 'rail-c', name: '刚结束的 smoke 回归', minutesAgo: 44 }),
  makeSession({ id: 'rail-d', name: '长期跟踪的客户反馈', minutesAgo: 90 }),
  makeSession({ id: 'rail-e', name: '权限模式的文案复核', minutesAgo: 150 }),
];

const OPEN_SESSION_ID = 'rail-a';

/** What a single row's menu asks for. */
const ROW_ACTIONS = {
  onToggleFlag: noop,
  onArchive: noop,
  onUnarchive: noop,
  onRename: noop,
};

/**
 * What a sweep asks for, answered locally.
 *
 * A story has no Host, and what a sweep does to the catalog is the row
 * actions' business rather than the selection's — the states worth looking at
 * here are the ones before a sweep runs.
 */
const SWEEPS = {
  archiveSelected: async () => undefined,
  flagSelected: async () => undefined,
} as unknown as SessionNavigationRowActions;

function StoryFrame(props: { children: ReactNode }) {
  // 260 is `SessionListPanel`'s own default width, and the height is the one
  // the other rail stories use so the two are comparable side by side.
  return (
    <div
      data-maka-e2e-fixture="true"
      style={{
        background: 'var(--surface-canvas)',
        height: 680,
        overflow: 'hidden',
        width: 260,
      }}
    >
      {props.children}
    </div>
  );
}

/**
 * The rail, wired to the real selection, with a run already picked.
 *
 * The initial pick is made through `commands.pick` rather than seeded as
 * state: it is the same pair of calls a click and a Shift-click make, so what
 * the story mounts is a set the reducer produced, not one a fixture asserted.
 */
function MultiSelectRail() {
  const selection = useSessionSelection({ sessions: SESSIONS, commands: SWEEPS });
  const commands = selection.commands;
  const seeded = useRef(false);

  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    const orderedSessionIds = SESSIONS.map((session) => session.id);
    commands.pick({ sessionId: 'rail-b', pick: 'replace', orderedSessionIds });
    commands.pick({ sessionId: 'rail-d', pick: 'range', orderedSessionIds });
  }, [commands]);

  return (
    <SessionRail
      selection={{ section: 'sessions' }}
      railSelection={selection}
      sessions={SESSIONS}
      activeId={OPEN_SESSION_ID}
      width={260}
      onSelectSession={noop}
      onSelect={noop}
      onOpenSettings={noop}
      onNew={noop}
      viewMode="conversation"
      onViewModeChange={noop}
      rowActions={ROW_ACTIONS}
    />
  );
}

// Real path: sidebar → click a task, then Shift-click one further down (or
// ⌘-click several). Three tasks are picked here and a fourth is open, which is
// the state the design turns on: picked and open share one ground, and only
// the open row is `aria-current`. The rail stays live — Shift-click, ⌘-click,
// Escape, right-click and ⋯ all work here as they do in the app.
export const PickedRun: Story = {
  render: () => (
    <StoryFrame>
      <MultiSelectRail />
    </StoryFrame>
  ),
};
