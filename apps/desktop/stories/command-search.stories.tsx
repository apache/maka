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
import { useEffect, useState } from 'react';
import type {
  RecallSearchOutcome,
  RecallSearchPassage,
} from '@maka/ui';
import { SearchModal } from '@maka/ui';
import {
  Download,
  FolderOpen,
  Plus,
  Settings,
} from '@maka/ui/icons';
import {
  CommandPalette,
  OverlaysRoot,
  OverlaysServicesProvider,
  type Command,
} from '../src/renderer/features/overlays/index.js';
import { createFakeOverlaysServices } from '../src/renderer/features/overlays/testing.js';
import { createSessionCatalogController } from '../src/renderer/application/contracts/session-catalog/session-catalog-state.js';
import type { DesktopSessionSummary } from '../src/shared/desktop-session-projection.js';

// Fidelity convention (#1433): every story below names the real app path
// that reaches it. See apps/desktop/stories/FIDELITY.md.

const meta = {
  title: 'Product/Command Search',
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;
type SearchResponse = RecallSearchOutcome | { ok: false; reason: string; message: string };
type SearchModalDeps = NonNullable<Parameters<typeof SearchModal>[0]['deps']>;

const noop = () => undefined;
const noopNavigate = (_sessionId: string, _turnId?: string) => undefined;
const EMPTY_HIDDEN_SESSIONS: ReadonlySet<string> = new Set();

function passage(
  sessionId: string,
  sessionTitle: string,
  anchorText: string,
  matchKind: string,
  turnId?: string,
): RecallSearchPassage {
  return {
    sessionId,
    sessionTitle,
    ...(turnId ? { turnId } : {}),
    anchorMessageId: `${sessionId}-anchor`,
    sequence: 4,
    messages: [
      {
        messageId: `${sessionId}-anchor`,
        role: 'assistant',
        matchKind,
        text: anchorText,
        timestamp: 1_700_000_000_000,
        isAnchor: true,
      },
    ],
    matchedTerms: [],
    score: 1,
  };
}

const recallPassages: RecallSearchPassage[] = [
  passage(
    'session-benchmark',
    'Benchmark 结果横评',
    '把 benchmark 输出整理成稳定的对比表，再补一轮 verifier。',
    'assistant_message',
    'turn-benchmark-table',
  ),
  passage(
    'session-command-search',
    'Command palette 搜索状态',
    'content search blocked state 要保持 disabled，不能触发关闭。',
    'user_message',
  ),
  passage(
    'session-harbor',
    'Harbor adapter metadata',
    '确认 provider env passthrough，不要复制本地 adapter。',
    'tool_intent',
    'turn-provider-env',
  ),
];

const paletteCommands: Command[] = [
  {
    id: 'action:new-chat',
    kind: 'action',
    label: '新建任务',
    hint: '开始新的任务',
    group: '操作',
    Icon: Plus,
    keywords: ['new', 'chat', '新建'],
    run: noop,
  },

  {
    id: 'settings:models',
    kind: 'action',
    label: '设置 · 模型',
    hint: '连接和模型',
    group: '设置',
    Icon: Settings,
    keywords: ['settings', 'models', '设置', '模型'],
    run: noop,
  },
  {
    id: 'diag:open-workspace',
    kind: 'action',
    label: '打开工作区文件夹',
    hint: 'Finder',
    group: '诊断',
    Icon: FolderOpen,
    keywords: ['workspace', 'folder', '工作区'],
    run: noop,
  },
  {
    id: 'diag:export-conversation',
    kind: 'action',
    label: '导出当前任务为 Markdown',
    hint: '复制到剪贴板',
    group: '诊断',
    Icon: Download,
    keywords: ['export', 'markdown', '导出'],
    run: noop,
  },
];

// Session rows come from the catalog, not the base list — seed one.
const storyCatalog = createSessionCatalogController();
const benchmarkSession = {
  id: 'session-benchmark',
  name: '生成本周 benchmark 对比表',
  revision: 1,
  activityAt: 1,
  isArchived: false,
  isFlagged: false,
  hasUnread: false,
  labels: [],
  status: 'active',
  backend: 'ai-sdk',
  llmConnectionSlug: 'openai-live',
  connectionLocked: true,
  model: 'gpt-5',
  permissionMode: 'ask',
  runtimeHostId: 'local',
  profileId: 'local',
  profileName: 'Local',
  profileKind: 'local',
} satisfies DesktopSessionSummary;
storyCatalog.commitSessions([benchmarkSession]);

function searchModalDeps(response: SearchResponse): SearchModalDeps {
  return {
    searchRecall: async () =>
      Array.isArray((response as RecallSearchOutcome).passages)
        ? (response as RecallSearchOutcome)
        : (response as { ok: false; reason: string; message: string }),
  };
}

const storyOverlayServices = createFakeOverlaysServices();

/** Opens the palette the way the shell does: through the overlays owner. */
function OpenPaletteOnMount(props: { openPalette(): void }) {
  const { openPalette } = props;
  useEffect(() => {
    const frame = window.requestAnimationFrame(openPalette);
    return () => window.cancelAnimationFrame(frame);
  }, [openPalette]);
  return null;
}

function CommandPaletteFrame(props: { commands: Command[] }) {
  return (
    <div
      style={{
        background: 'var(--surface-canvas)',
        height: '680px',
        position: 'relative',
      }}
    >
      <OverlaysServicesProvider services={storyOverlayServices}>
        <OverlaysRoot>
          {(overlays) => (
            <>
              <OpenPaletteOnMount openPalette={overlays.commands.openPalette} />
              <CommandPalette
                commands={props.commands}
                sessionCatalog={storyCatalog}
                hiddenSessionIds={EMPTY_HIDDEN_SESSIONS}
                activeSessionId="session-benchmark"
                onSelectSession={noop}
              />
            </>
          )}
        </OverlaysRoot>
      </OverlaysServicesProvider>
    </div>
  );
}

function SearchModalFrame(props: {
  deps?: SearchModalDeps;
}) {
  const [isOpen, setIsOpen] = useState(false);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setIsOpen(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);
  return (
    <div
      style={{
        background: 'var(--surface-canvas)',
        minHeight: '680px',
      }}
    >
      <SearchModal
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        onNavigateToSession={noopNavigate}
        deps={props.deps}
      />
    </div>
  );
}

async function wait(ms: number) {
  await new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function enterQuery(canvasElement: HTMLElement, selector: string, value: string) {
  await wait(0);
  const input = canvasElement.ownerDocument.querySelector<HTMLInputElement>(selector);
  if (!input) return;
  input.focus();
  setInputValue(input, value);
  await wait(260);
}

// Real path: ⌘K → the palette with commands grouped by kind.
export const CommandPaletteGroupedResults: Story = {
  render: () => (
    <CommandPaletteFrame
      commands={paletteCommands}
    />
  ),
};

const recallOutcome: RecallSearchOutcome = {
  passages: recallPassages,
  gaps: 'Searched 3 Session(s).',
  searchedEverySession: true,
};

// Real path: same modal with matches, grouped by session with the matched excerpt.
export const SearchModalResults: Story = {
  render: () => (
    <SearchModalFrame
      deps={searchModalDeps(recallOutcome)}
    />
  ),
  play: async ({ canvasElement }) => {
    await enterQuery(canvasElement, '[data-maka-contract="search-modal"] input', 'benchmark');
  },
};
