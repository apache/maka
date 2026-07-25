import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlanReminder, SessionSummary } from '@maka/core';
import { LocaleProvider } from '../locale-context.js';
import { ModuleHubSelector } from '../module-hub-selector.js';
import { SessionListPanel } from '../session-list-panel.js';
import { SessionSidebarNav } from '../session-sidebar-nav.js';

function renderSidebarNav(): string {
  return renderToStaticMarkup(
    <LocaleProvider locale="zh">
      <SessionSidebarNav
        selection={{ section: 'sessions', filter: 'chats' }}
        onSelect={() => {}}
        onNew={() => {}}
      />
    </LocaleProvider>,
  );
}

describe('sidebar subtraction', () => {
  it('keeps only the hub-level destinations in permanent navigation', () => {
    const markup = renderSidebarNav();

    assert.match(markup, />新任务</);
    assert.match(markup, />扩展</);
    assert.match(markup, />定时任务</);
    assert.doesNotMatch(markup, />技能</);
    assert.doesNotMatch(markup, />MCP</);
    assert.doesNotMatch(markup, />每日回顾</);
    assert.doesNotMatch(markup, /aria-expanded=/);
  });

  it('keeps the visible scheduled-task label in its pending-reminder accessible name', () => {
    const reminder: PlanReminder = {
      id: 'reminder-1',
      title: 'Review open work',
      note: '',
      schedule: { kind: 'once', runAt: 1 },
      delivery: { channel: 'local' },
      status: 'scheduled',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      runs: [],
      runCount: 0,
    };
    const markup = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <SessionSidebarNav
          selection={{ section: 'automations', module: 'plan-reminders' }}
          planReminders={[reminder]}
          onSelect={() => {}}
          onNew={() => {}}
        />
      </LocaleProvider>,
    );

    assert.match(markup, /aria-label="Scheduled tasks, 1 unfinished reminder"/);
    assert.match(markup, />Scheduled tasks</);
    assert.doesNotMatch(markup, /aria-label="Automations,/);
  });

  it('renders each child module as a localized path selector instead of a segmented control', () => {
    const extensions = renderToStaticMarkup(
      <LocaleProvider locale="zh">
        <ModuleHubSelector hub="extensions" value="skills" onChange={() => {}} />
      </LocaleProvider>,
    );
    const automations = renderToStaticMarkup(
      <LocaleProvider locale="zh">
        <ModuleHubSelector hub="automations" value="plan-reminders" onChange={() => {}} />
      </LocaleProvider>,
    );

    assert.match(extensions, /class="maka-module-hub-selector"/);
    assert.match(extensions, /aria-label="扩展内容：技能"/);
    assert.match(extensions, /aria-haspopup="menu"/);
    assert.match(extensions, />技能</);
    assert.doesNotMatch(extensions, /maka-segmented/);
    assert.match(automations, /class="maka-module-hub-selector"/);
    assert.match(automations, /aria-label="定时任务内容：计划提醒"/);
    assert.match(automations, />计划提醒</);
    assert.doesNotMatch(automations, /maka-segmented/);
  });

  it('moves session grouping from a permanent segmented control into the list heading', () => {
    const session: SessionSummary = {
      id: 'session-1',
      name: '侧栏减法',
      status: 'active',
      isFlagged: false,
      isArchived: false,
      labels: [],
      hasUnread: false,
      lastMessageAt: 1,
      backend: 'ai-sdk',
      llmConnectionSlug: 'anthropic-main',
      connectionLocked: false,
      model: 'claude-sonnet-4-5',
      permissionMode: 'ask',
    };
    const markup = renderToStaticMarkup(
      <LocaleProvider locale="zh">
        <SessionListPanel
          selection={{ section: 'sessions', filter: 'chats' }}
          sessions={[session]}
          viewMode="conversation"
          onViewModeChange={() => {}}
          onSelectSession={() => {}}
          onSelect={() => {}}
          onOpenSettings={() => {}}
          onNew={() => {}}
        />
      </LocaleProvider>,
    );

    assert.match(markup, /class="maka-session-list-heading"[^>]*>会话</);
    assert.match(markup, /aria-label="会话分组方式"/);
    assert.doesNotMatch(markup, />按状态</);
    assert.doesNotMatch(markup, />按项目</);
  });

  it('keeps conversation view controls visible while an extension module is selected', () => {
    const markup = renderToStaticMarkup(
      <LocaleProvider locale="zh">
        <SessionListPanel
          selection={{ section: 'extensions', module: 'skills' }}
          sessions={[]}
          viewMode="conversation"
          onViewModeChange={() => {}}
          onSelectSession={() => {}}
          onSelect={() => {}}
          onOpenSettings={() => {}}
          onNew={() => {}}
        />
      </LocaleProvider>,
    );

    assert.match(markup, /class="maka-session-list-heading"[^>]*>会话</);
    assert.match(markup, /aria-label="会话分组方式"/);
  });

  it('labels only the exceptional pinned section in the flat conversation list', () => {
    const makeSession = (
      session: Pick<SessionSummary, 'id' | 'name' | 'status' | 'isFlagged' | 'lastMessageAt'>,
    ): SessionSummary => ({
      ...session,
      isArchived: false,
      labels: [],
      hasUnread: false,
      backend: 'ai-sdk',
      llmConnectionSlug: 'anthropic-main',
      connectionLocked: false,
      model: 'claude-sonnet-4-5',
      permissionMode: 'ask',
    });
    const sessions = [
      makeSession({
        id: 'recent-older',
        name: '较早会话',
        status: 'done',
        isFlagged: false,
        lastMessageAt: 100,
      }),
      makeSession({
        id: 'pinned-older',
        name: '较早置顶',
        status: 'blocked',
        isFlagged: true,
        lastMessageAt: 200,
      }),
      makeSession({
        id: 'recent-newer',
        name: '最近会话',
        status: 'active',
        isFlagged: false,
        lastMessageAt: 400,
      }),
      makeSession({
        id: 'pinned-newer',
        name: '最近置顶',
        status: 'running',
        isFlagged: true,
        lastMessageAt: 300,
      }),
    ];
    const markup = renderToStaticMarkup(
      <LocaleProvider locale="zh">
        <SessionListPanel
          selection={{ section: 'sessions', filter: 'chats' }}
          sessions={sessions}
          viewMode="conversation"
          onViewModeChange={() => {}}
          onSelectSession={() => {}}
          onSelect={() => {}}
          onOpenSettings={() => {}}
          onNew={() => {}}
        />
      </LocaleProvider>,
    );

    const groupLabels = [...markup.matchAll(/class="maka-list-group-label"[^>]*><span>([^<]+)<\/span>/g)]
      .map((match) => match[1]);
    assert.deepEqual(groupLabels, ['置顶']);
    assert.ok(markup.indexOf('最近置顶') < markup.indexOf('较早置顶'));
    assert.ok(markup.indexOf('最近会话') < markup.indexOf('较早会话'));
    assert.doesNotMatch(markup, /maka-list-group-toggle|maka-list-group-count|aria-expanded=/);
  });
});
