import type { SessionSummary } from '@maka/core';
import { LocaleProvider, SessionListPanel } from '@maka/ui';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

export function makeSessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'session-1',
    name: '测试会话',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'test-connection',
    connectionLocked: false,
    model: 'test-model',
    permissionMode: 'ask',
    ...overrides,
  };
}

export function renderSessionListPanel(options: {
  session?: Partial<SessionSummary>;
  sessions?: SessionSummary[];
  activeId?: string;
  rowActions?: Parameters<typeof SessionListPanel>[0]['rowActions'];
  groups?: Parameters<typeof SessionListPanel>[0]['groups'];
  projectActions?: Parameters<typeof SessionListPanel>[0]['projectActions'];
  worktreeSessionIds?: Parameters<typeof SessionListPanel>[0]['worktreeSessionIds'];
  staleSessionIds?: Parameters<typeof SessionListPanel>[0]['staleSessionIds'];
  viewMode?: Parameters<typeof SessionListPanel>[0]['viewMode'];
} = {}): string {
  const rowActions = options.rowActions ?? {
    onToggleFlag() {},
    onArchive() {},
    onUnarchive() {},
    onRename() {},
    onDelete() {},
  };

  return renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'zh',
    children: createElement(SessionListPanel, {
      selection: { section: 'sessions', filter: 'chats' },
      sessions: options.sessions ?? [makeSessionSummary(options.session)],
      activeId: options.activeId,
      groups: options.groups,
      projectActions: options.projectActions,
      worktreeSessionIds: options.worktreeSessionIds,
      staleSessionIds: options.staleSessionIds,
      viewMode: options.viewMode,
      onViewModeChange: options.viewMode ? () => {} : undefined,
      onSelectSession() {},
      onSelect() {},
      onOpenSettings() {},
      onNew() {},
      rowActions,
    } satisfies Parameters<typeof SessionListPanel>[0]),
  }));
}
