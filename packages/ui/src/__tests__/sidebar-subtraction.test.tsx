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

  it('keeps pending-reminder state in the collapsed SideNavItem accessible name', () => {
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
        <SessionListPanel
          collapsed
          selection={{ section: 'automations', module: 'plan-reminders' }}
          planReminders={[reminder]}
          sessions={[]}
          onSelectSession={() => {}}
          onSelect={() => {}}
          onOpenSettings={() => {}}
          onNew={() => {}}
        />
      </LocaleProvider>,
    );

    assert.match(markup, /aria-label="Scheduled tasks, 1 unfinished reminder"/);
    assert.doesNotMatch(markup, /maka-nav-count/);
  });

  it('pins permanent destinations in SideNav topContent outside the scroll history', () => {
    const session: SessionSummary = {
      id: 'session-1',
      name: '侧栏置顶导航',
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
    const expanded = renderToStaticMarkup(
      <LocaleProvider locale="zh">
        <SessionListPanel
          selection={{ section: 'sessions', filter: 'chats' }}
          sessions={[session]}
          onSelectSession={() => {}}
          onSelect={() => {}}
          onOpenSettings={() => {}}
          onNew={() => {}}
        />
      </LocaleProvider>,
    );
    assert.match(expanded, /maka-session-panel-top/);
    assert.ok(
      expanded.indexOf('maka-session-panel-top') < expanded.indexOf('maka-session-list'),
      'permanent nav top slot must precede scrollable session history',
    );
    assert.match(expanded, /maka-session-panel-top[\s\S]*?>新任务</);
    assert.match(expanded, /maka-session-list[\s\S]*侧栏置顶导航/);

    const collapsed = renderToStaticMarkup(
      <LocaleProvider locale="zh">
        <SessionListPanel
          collapsed
          selection={{ section: 'sessions', filter: 'chats' }}
          sessions={[session]}
          onSelectSession={() => {}}
          onSelect={() => {}}
          onOpenSettings={() => {}}
          onNew={() => {}}
        />
      </LocaleProvider>,
    );
    assert.match(collapsed, /maka-session-panel-top/);
    assert.doesNotMatch(collapsed, /maka-session-list/);
    assert.doesNotMatch(collapsed, /侧栏置顶导航/);
  });

  it('renders each pair of peer modules as localized view navigation', () => {
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

    assert.match(extensions, /astryx-tab-list/);
    assert.match(extensions, /aria-label="扩展内容：技能"/);
    assert.doesNotMatch(extensions, /role="radiogroup"/);
    assert.match(extensions, /aria-current="page"/);
    assert.match(extensions, />技能</);
    assert.match(extensions, />MCP</);
    assert.doesNotMatch(extensions, /aria-haspopup="menu"/);
    assert.match(automations, /astryx-tab-list/);
    assert.match(automations, /aria-label="定时任务内容：计划提醒"/);
    assert.match(automations, />计划提醒</);
    assert.match(automations, />每日回顾</);
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

    assert.match(markup, /maka-session-heading-section/);
    assert.match(markup, /aria-label="会话分组方式"/);
    assert.doesNotMatch(markup, />按状态</);
    // Both axes are on screen as an exclusive switch, not behind a menu: the
    // group is a radiogroup and each segment names itself through aria-label,
    // since the label is visually hidden behind the icon.
    assert.match(markup, /role="radiogroup"[\s\S]*aria-label="按项目"/);
    assert.doesNotMatch(markup, /role="menuitemradio"/);
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

    assert.match(markup, /maka-session-heading-section/);
    assert.match(markup, />会话</);
    assert.match(markup, /aria-label="会话分组方式"/);
  });

  it('labels pinned and recent as two SideNav sections in the conversation list', () => {
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

    assert.match(markup, />置顶</);
    assert.match(markup, />最近</);
    assert.ok(markup.indexOf('置顶') < markup.indexOf('最近'));
    assert.ok(markup.indexOf('最近置顶') < markup.indexOf('较早置顶'));
    assert.ok(markup.indexOf('最近会话') < markup.indexOf('较早会话'));
    assert.ok(markup.indexOf('最近置顶') < markup.indexOf('最近会话'));
    assert.doesNotMatch(markup, /maka-list-group-toggle/);
  });
});
