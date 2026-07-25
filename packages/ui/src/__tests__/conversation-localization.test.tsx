import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type {
  AnyPermissionRequestEvent,
  SessionSummary,
  UiLocale,
  UserQuestionRequestEvent,
} from '@maka/core';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmptyChatHero } from '../chat-empty-hero.js';
import { Composer } from '../composer.js';
import { LocaleProvider } from '../locale-context.js';
import { PermissionPrompt } from '../permission-dialog.js';
import { SessionHistoryList } from '../session-history-list.js';
import { ToolTrow } from '../tool-activity.js';
import { summarizeTrowTools } from '../tool-activity/trow-summary.js';
import { UserQuestionPrompt } from '../user-question-prompt.js';
import { ModelProviderRetryIndicator } from '../chat-turn.js';

function render(locale: UiLocale, children: ReactNode): string {
  return renderToStaticMarkup(<LocaleProvider locale={locale}>{children}</LocaleProvider>);
}

const permissionRequest = {
  id: 'event-permission',
  turnId: 'turn-1',
  ts: 1,
  type: 'permission_request',
  kind: 'tool_permission',
  requestId: 'request-1',
  toolUseId: 'tool-1',
  toolName: 'RawShellTool',
  category: 'shell_unsafe',
  reason: 'shell_dangerous',
  args: { command: 'echo RAW_COMMAND_中文' },
  rememberForTurnAllowed: true,
} satisfies AnyPermissionRequestEvent;

const questionRequest = {
  id: 'event-question',
  turnId: 'turn-1',
  ts: 2,
  type: 'user_question_request',
  requestId: 'question-1',
  toolUseId: 'tool-question',
  questions: [{ question: 'RAW_QUESTION_中文', options: [{ label: 'RAW_OPTION_中文' }] }],
} satisfies UserQuestionRequestEvent;

const archivedSession = {
  id: 'session-archived',
  name: 'Archived conversation',
  isFlagged: false,
  isArchived: true,
  labels: [],
  hasUnread: false,
  status: 'archived',
  backend: 'ai-sdk',
  llmConnectionSlug: 'test-connection',
  connectionLocked: false,
  model: 'test-model',
  permissionMode: 'ask',
} satisfies SessionSummary;

describe('localized conversation journey', () => {
  it('renders provider retry attempts without exposing provider error details', () => {
    const retry = {
      type: 'provider_retry',
      id: 'retry-1',
      turnId: 'turn-1',
      ts: 1,
      phase: 'scheduled',
      attempt: 3,
      maxAttempts: 10,
      delayMs: 4_000,
      reason: 'rate_limit',
    } as const;

    assert.match(render('zh', <ModelProviderRetryIndicator retry={retry} />), /4 秒后重试（3\/10）/);
    assert.match(render('en', <ModelProviderRetryIndicator retry={retry} />), /Retrying in 4s \(3\/10\)/);
  });

  it('renders coherent empty and composer states in Chinese and English', () => {
    const surface = (
      <>
        <EmptyChatHero userLabel="RawUser" />
        <Composer onSend={() => {}} onStop={() => {}} />
      </>
    );
    const zh = render('zh', surface);
    const en = render('en', surface);

    assert.match(zh, /aria-label="开始对话"/);
    // U6: placeholder teaches the @ 引用文件 / 选择技能 mentions in both locales.
    assert.match(zh, /placeholder="描述任务，@ 引用文件，\/ 选择技能…"/);
    assert.match(zh, /aria-label="发送"/);
    assert.match(en, /aria-label="Start a conversation"/);
    assert.match(en, /placeholder="Describe a task, @ to reference files, \/ for skills…"/);
    assert.match(en, /aria-label="Send"/);
    assert.doesNotMatch(en, /开始对话|描述任务|发送/);
    assert.match(en, /RawUser/);
  });

  it('surfaces the no-model dead-end hint and explanatory Send title (U3)', () => {
    const withHint = render(
      'zh',
      <Composer onSend={() => {}} onStop={() => {}} noModelConnection onOpenModelSettings={() => {}} />,
    );
    // Inline hint above the composer box + link-button into 模型 settings.
    assert.match(withHint, /maka-composer-no-model-hint/);
    assert.match(withHint, /还没有可用的模型连接，无法发送。/);
    assert.match(withHint, /maka-composer-no-model-hint-action[^>]*>前往模型设置</);
    // Disabled Send carries the explanatory title (not the neutral 发送 label).
    assert.match(withHint, /type="submit"[^>]*disabled[^>]*title="先添加一个模型连接才能发送。"/);
    // Default (a model connection exists) shows neither the hint nor the title.
    const noHint = render('zh', <Composer onSend={() => {}} onStop={() => {}} />);
    assert.doesNotMatch(noHint, /maka-composer-no-model-hint/);
    assert.doesNotMatch(noHint, /先添加一个模型连接才能发送。/);

    const en = render(
      'en',
      <Composer onSend={() => {}} onStop={() => {}} noModelConnection onOpenModelSettings={() => {}} />,
    );
    assert.match(en, /No model connection yet, so sending is unavailable\./);
    assert.match(en, /Go to model settings/);
  });

  it('keeps Plan Mode out of the toolbar and reachable from the ＋ menu (#1433)', () => {
    const markup = render(
      'zh',
      <Composer onSend={() => {}} onStop={() => {}} onPickAttachments={() => {}} onPlanModeChange={() => {}} />,
    );
    // The toolbar no longer carries a standalone Plan switch…
    assert.doesNotMatch(markup, /maka-composer-plan-mode-control/);
    // …but the ＋ trigger is present so the mode stays reachable from the menu.
    assert.match(markup, /aria-label="添加"/);
  });

  it('keeps the ＋ menu available when only mode switches are wired', () => {
    const markup = render('zh', <Composer onSend={() => {}} onStop={() => {}} onPlanModeChange={() => {}} />);
    assert.match(markup, /aria-label="添加"/);
    assert.doesNotMatch(markup, /maka-composer-plan-mode-control/);
  });

  it('shows a quiet Plan indicator next to permission mode only while Plan is active', () => {
    const on = render(
      'zh',
      <Composer onSend={() => {}} onStop={() => {}} planModeActive onPlanModeChange={() => {}} />,
    );
    assert.match(on, /maka-composer-mode-indicator/);
    assert.match(on, /Plan 模式已启用/);
    // Same visual language as the permission select: a quiet text BUTTON
    // with an explicit close icon (no chevron — it cannot drop down);
    // clicking turns the mode off.
    assert.match(on, /<button[^>]*maka-composer-mode-indicator/);
    assert.match(
      on,
      /<button[^>]*maka-composer-mode-indicator[^>]*>(?:(?!<\/button>)[\s\S])*?<svg[^>]*class="lucide lucide-x"[^>]*aria-hidden="true"/,
    );

    const off = render('zh', <Composer onSend={() => {}} onStop={() => {}} onPlanModeChange={() => {}} />);
    assert.doesNotMatch(off, /maka-composer-mode-indicator/);
  });

  it('keeps the active-mode indicator visible but disabled with reason while streaming', () => {
    const markup = render(
      'zh',
      <Composer
        onSend={() => {}}
        onStop={() => {}}
        streaming
        swarmModeActive
        swarmModeDisabledReason="等待流式输出结束"
        onSwarmModeChange={() => {}}
      />,
    );
    assert.match(markup, /maka-composer-mode-indicator/);
    assert.match(markup, /Swarm 模式已启用/);
    assert.match(markup, /disabled=""/);
    assert.match(markup, /等待流式输出结束/);
    assert.match(
      markup,
      /<button[^>]*maka-composer-mode-indicator[^>]*>(?:(?!<\/button>)[\s\S])*?<svg[^>]*class="lucide lucide-x"[^>]*aria-hidden="true"/,
    );
  });

  it('keeps the ＋ menu reachable while streaming (#1444)', () => {
    const markup = render(
      'zh',
      <Composer
        onSend={() => {}}
        onStop={() => {}}
        streaming
        onPickAttachments={() => {}}
        expertTeams={[{ id: 'team-a', name: '专家团 A' }]}
        onStartExpertTeam={() => {}}
        onPlanModeChange={() => {}}
        onSwarmModeChange={() => {}}
      />,
    );
    // Menu trigger must stay mounted mid-turn so attachments, expert teams,
    // and Plan/Swarm remain reachable from the ＋ menu (import itself stays
    // blocked mid-stream by runImportAction / the disabled attach item).
    assert.match(markup, /aria-label="添加"/);
  });

  it('keeps Swarm Mode out of the toolbar (#1433)', () => {
    const markup = render(
      'zh',
      <Composer onSend={() => {}} onStop={() => {}} onPickAttachments={() => {}} onSwarmModeChange={() => {}} />,
    );
    assert.doesNotMatch(markup, /maka-composer-swarm-mode-control/);
    assert.match(markup, /aria-label="添加"/);
  });

  it('localizes permission and question chrome while preserving raw values', () => {
    const surface = (
      <>
        <PermissionPrompt request={permissionRequest} onRespond={() => {}} onStop={() => {}} />
        <UserQuestionPrompt request={questionRequest} onRespond={() => {}} onStop={() => {}} />
      </>
    );
    const zh = render('zh', surface);
    const en = render('en', surface);

    assert.match(zh, /允许执行高风险 shell 命令？/);
    assert.match(zh, /允许操作/);
    assert.match(en, /Allow a high-risk shell command\?/);
    assert.match(en, />Allow</);
    assert.match(en, /Other/);
    for (const raw of ['RAW_QUESTION_中文', 'RAW_OPTION_中文']) {
      assert.match(zh, new RegExp(raw));
      assert.match(en, new RegExp(raw));
    }
  });

  it('localizes stale permission wait durations without mixing unit languages', () => {
    const staleRequest = {
      ...permissionRequest,
      ts: Date.now() - 6 * 60_000,
    } satisfies AnyPermissionRequestEvent;
    const zh = render(
      'zh',
      <PermissionPrompt request={staleRequest} onRespond={() => {}} onStop={() => {}} />,
    );
    const en = render(
      'en',
      <PermissionPrompt request={staleRequest} onRespond={() => {}} onStop={() => {}} />,
    );

    assert.match(zh, /已等待 6 分钟/);
    assert.match(en, /Waiting for 6 minutes/);
    assert.doesNotMatch(en, /分钟|小时/);
  });

  it('keeps the default conversation list flat without a redundant time heading', () => {
    const zh = render(
      'zh',
      <SessionHistoryList
        sessions={[archivedSession]}
        onSelectSession={() => {}}
      />,
    );
    const en = render(
      'en',
      <SessionHistoryList
        sessions={[archivedSession]}
        onSelectSession={() => {}}
      />,
    );

    assert.match(zh, /Archived conversation/);
    assert.match(en, /Archived conversation/);
    assert.doesNotMatch(
      `${zh}${en}`,
      /maka-list-group-label|maka-list-group-toggle|maka-list-group-count|aria-expanded/,
    );
  });

  it('localizes live tool activity without rewriting tool-owned text', () => {
    const tool = {
      toolUseId: 'tool-raw',
      toolName: 'RawTool',
      intent: 'RAW_INTENT_中文',
      status: 'running' as const,
      args: { command: 'RAW_COMMAND_中文' },
    };
    const zh = render('zh', <ToolTrow items={[tool]} />);
    const en = render('en', <ToolTrow items={[tool]} />);

    const summaryItems = [
      { toolUseId: 'read-1', toolName: 'Read', status: 'running' as const, args: {} },
      { toolUseId: 'read-2', toolName: 'Read', status: 'completed' as const, args: {} },
    ];
    assert.match(summarizeTrowTools(summaryItems, { live: true, locale: 'zh' }), /^正在/);
    assert.match(summarizeTrowTools(summaryItems, { live: true, locale: 'en' }), /^Working:/);
    assert.match(zh, /RAW_INTENT_中文/);
    assert.match(en, /RAW_INTENT_中文/);
  });
});
