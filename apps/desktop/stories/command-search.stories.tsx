import type { Meta, StoryObj } from '@storybook/react-vite';
import type { SearchErrorReason, SearchResult } from '@maka/core';
import { SearchModal } from '@maka/ui';
import {
  Download,
  FolderOpen,
  MessageSquare,
  Plus,
  Search,
  Settings,
  Sparkles,
} from '@maka/ui/icons';
import { CommandPalette } from '../src/renderer/command-palette';
import type { Command } from '../src/renderer/command-palette-types';
import type { UseThreadSearchDeps } from '../src/renderer/use-thread-search';

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
type SearchResponse = SearchResult[] | { ok: false; reason: SearchErrorReason; message: string };
type SearchModalDeps = NonNullable<Parameters<typeof SearchModal>[0]['deps']>;

const noop = () => undefined;
const noopNavigate = (_sessionId: string, _turnId?: string) => undefined;

const threadResults: SearchResult[] = [
  {
    source: 'thread',
    title: 'Benchmark 结果横评',
    summary: '会话 · 今天 10:24',
    snippet: '把 benchmark 输出整理成稳定的对比表，再补一轮 verifier。',
    target: { kind: 'thread', sessionId: 'session-benchmark', turnId: 'turn-benchmark-table' },
    truncated: true,
  },
  {
    source: 'thread',
    title: 'Command palette 搜索状态',
    summary: '会话 · 昨天 18:42',
    snippet: 'content search blocked state 要保持 disabled，不能触发关闭。',
    target: { kind: 'thread', sessionId: 'session-command-search' },
  },
  {
    source: 'thread',
    title: 'Harbor adapter metadata',
    summary: '会话 · 周一',
    snippet: '确认 provider env passthrough，不要复制本地 adapter。',
    target: { kind: 'thread', sessionId: 'session-harbor', turnId: 'turn-provider-env' },
  },
];

const paletteCommands: Command[] = [
  {
    id: 'action:new-chat',
    kind: 'action',
    label: '新建对话',
    hint: '开始新的会话',
    group: '操作',
    Icon: Plus,
    keywords: ['new', 'chat', '新建'],
    run: noop,
  },
  {
    id: 'action:new-deep-research',
    kind: 'action',
    label: '新建深度研究',
    hint: '只读探索',
    group: '操作',
    Icon: Sparkles,
    keywords: ['deep', 'research', '研究'],
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
    label: '导出当前对话为 Markdown',
    hint: '复制到剪贴板',
    group: '诊断',
    Icon: Download,
    keywords: ['export', 'markdown', '导出'],
    run: noop,
  },
  {
    id: 'session:benchmark',
    kind: 'session',
    label: '生成本周 benchmark 对比表',
    hint: '当前',
    group: '会话',
    Icon: MessageSquare,
    keywords: ['benchmark', '会话'],
    run: noop,
  },
];

const idlePaletteSearchDeps = {
  runSearch: async () => [],
} satisfies UseThreadSearchDeps;

const loadingPaletteSearchDeps = {
  runSearch: () => new Promise<SearchResponse>(() => undefined),
} satisfies UseThreadSearchDeps;

function paletteSearchDeps(response: SearchResponse): UseThreadSearchDeps {
  return {
    runSearch: async () => response,
  };
}

const loadingSearchModalDeps = {
  searchThread: () => new Promise<SearchResponse>(() => undefined),
} satisfies SearchModalDeps;

function searchModalDeps(response: SearchResponse): SearchModalDeps {
  return {
    searchThread: async () => response,
  };
}

function CommandPaletteFrame(props: {
  commands: Command[];
  threadSearchDeps?: UseThreadSearchDeps;
}) {
  return (
    <div
      style={{
        background: 'var(--surface-canvas)',
        height: '680px',
        position: 'relative',
      }}
    >
      <CommandPalette
        commands={props.commands}
        onClose={noop}
        onSelectSession={noopNavigate}
        threadSearchDeps={props.threadSearchDeps ?? idlePaletteSearchDeps}
      />
    </div>
  );
}

function SearchModalFrame(props: {
  deps?: SearchModalDeps;
}) {
  return (
    <div
      style={{
        background: 'var(--surface-canvas)',
        minHeight: '680px',
      }}
    >
      <SearchModal
        onClose={noop}
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

async function pressPaletteKey(canvasElement: HTMLElement, key: string) {
  const input = canvasElement.ownerDocument.querySelector<HTMLInputElement>('.maka-palette-input');
  if (!input) return;
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  await wait(0);
}

// Real path: ⌘K (or 更多操作 → 打开命令面板) → the palette with commands grouped by kind.
export const CommandPaletteGroupedResults: Story = {
  render: () => (
    <CommandPaletteFrame
      commands={paletteCommands}
    />
  ),
};

// Real path: ⌘K → type a query that matches nothing. There is no
// no-commands-at-all state to render: `buildCommandList` always emits
// 新建对话 first (command-palette-commands.ts), so the palette's empty branch
// is only ever reached through a query — and its copy says so
// ("没有匹配的命令 / 换个关键词").
export const CommandPaletteNoMatch: Story = {
  render: () => (
    <CommandPaletteFrame
      commands={paletteCommands}
    />
  ),
  play: async ({ canvasElement }) => {
    await enterQuery(canvasElement, '.maka-palette-input', 'zzzzz-no-such-command');
  },
};

// A `CommandPaletteDisabledCommand` story used to sit here, hand-building a
// `thread-search:blocked` row into the base command list and rendering it with
// no query. `buildCommandList` never emits a disabled command; the only
// disabled row in the product comes from `buildContentSearchCommands`, which
// runs only after a query of at least two code points. The reachable version
// of this state is `CommandPaletteContentSearchBlocked` below, driven through
// the real builder.

// Real path: ⌘K then ↓↓ — the keyboard-driven selection ring, which the mouse path never
// shows.
export const CommandPaletteKeyboardFocusedSelection: Story = {
  render: () => (
    <CommandPaletteFrame
      commands={paletteCommands}
    />
  ),
  play: async ({ canvasElement }) => {
    await pressPaletteKey(canvasElement, 'ArrowDown');
    await pressPaletteKey(canvasElement, 'ArrowDown');
  },
};

// Real path: ⌘K → type a query → the palette also searches conversation content; this is
// the in-flight state.
export const CommandPaletteContentSearchLoading: Story = {
  render: () => (
    <CommandPaletteFrame
      commands={[]}
      threadSearchDeps={loadingPaletteSearchDeps}
    />
  ),
  play: async ({ canvasElement }) => {
    await enterQuery(canvasElement, '.maka-palette-input', 'benchmark');
  },
};

// Real path: same, once content matches come back and merge below the command groups.
export const CommandPaletteContentSearchResults: Story = {
  render: () => (
    <CommandPaletteFrame
      commands={[]}
      threadSearchDeps={paletteSearchDeps(threadResults)}
    />
  ),
  play: async ({ canvasElement }) => {
    await enterQuery(canvasElement, '.maka-palette-input', 'benchmark');
  },
};

// Real path: same, when the content-search provider fails.
export const CommandPaletteContentSearchError: Story = {
  render: () => (
    <CommandPaletteFrame
      commands={[]}
      threadSearchDeps={paletteSearchDeps({
        ok: false,
        reason: 'provider_error',
        message: '搜索服务暂时不可用，请稍后重试。',
      })}
    />
  ),
  play: async ({ canvasElement }) => {
    await enterQuery(canvasElement, '.maka-palette-input', 'benchmark');
  },
};

// Real path: same, with incognito on — Maka refuses to read local history rather than
// returning nothing.
export const CommandPaletteContentSearchBlocked: Story = {
  render: () => (
    <CommandPaletteFrame
      commands={[]}
      threadSearchDeps={paletteSearchDeps({
        ok: false,
        reason: 'incognito_active',
        message: '隐私模式打开时不会读取本地历史内容。',
      })}
    />
  ),
  play: async ({ canvasElement }) => {
    await enterQuery(canvasElement, '.maka-palette-input', 'benchmark');
  },
};

// Real path: titlebar 搜索 icon (app-shell-chrome-actions.tsx) → the modal before anything
// is typed.
export const SearchModalEmpty: Story = {
  render: () => (
    <SearchModalFrame
      deps={searchModalDeps([])}
    />
  ),
};

// Real path: same modal → type a query → the in-flight state.
export const SearchModalLoading: Story = {
  render: () => (
    <SearchModalFrame
      deps={loadingSearchModalDeps}
    />
  ),
  play: async ({ canvasElement }) => {
    await enterQuery(canvasElement, '.maka-search-modal-input', 'benchmark');
  },
};

// Real path: same modal with matches, grouped by session with the matched excerpt.
export const SearchModalResults: Story = {
  render: () => (
    <SearchModalFrame
      deps={searchModalDeps(threadResults)}
    />
  ),
  play: async ({ canvasElement }) => {
    await enterQuery(canvasElement, '.maka-search-modal-input', 'benchmark');
  },
};

// Real path: same modal with a query that matches nothing.
export const SearchModalNoResults: Story = {
  render: () => (
    <SearchModalFrame
      deps={searchModalDeps([])}
    />
  ),
  play: async ({ canvasElement }) => {
    await enterQuery(canvasElement, '.maka-search-modal-input', 'unmatched');
  },
};

// Real path: same modal when the search index is unavailable.
export const SearchModalError: Story = {
  render: () => (
    <SearchModalFrame
      deps={searchModalDeps({
        ok: false,
        reason: 'provider_error',
        message: '搜索索引暂时不可用，请稍后重试。',
      })}
    />
  ),
  play: async ({ canvasElement }) => {
    await enterQuery(canvasElement, '.maka-search-modal-input', 'benchmark');
  },
};

// Real path: same modal with incognito on — search is disabled rather than silently
// empty.
export const SearchModalBlocked: Story = {
  render: () => (
    <SearchModalFrame
      deps={searchModalDeps({
        ok: false,
        reason: 'incognito_active',
        message: 'Search is disabled while incognito is active.',
      })}
    />
  ),
  play: async ({ canvasElement }) => {
    await enterQuery(canvasElement, '.maka-search-modal-input', 'benchmark');
  },
};
