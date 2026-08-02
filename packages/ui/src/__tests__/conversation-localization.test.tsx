import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type {
  SandboxBoundaryRequestEvent,
  SessionSummary,
  UiLocale,
  UserQuestionRequestEvent,
} from '@maka/core';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmptyChatHero } from '../chat-empty-hero.js';
import { Composer } from '../composer.js';
import { LocaleProvider } from '../locale-context.js';
import { SessionHistoryList } from '../session-history-list.js';
import { SandboxBoundaryPrompt } from '../sandbox-boundary-prompt.js';
import { ToolTrow } from '../tool-activity.js';
import { summarizeTrowTools } from '../tool-activity/trow-summary.js';
import { UserQuestionPrompt } from '../user-question-prompt.js';
import { ModelProviderRetryIndicator, TurnView } from '../chat-turn.js';

function render(locale: UiLocale, children: ReactNode): string {
  return renderToStaticMarkup(<LocaleProvider locale={locale}>{children}</LocaleProvider>);
}

const questionRequest = {
  id: 'event-question',
  turnId: 'turn-1',
  ts: 2,
  type: 'user_question_request',
  requestId: 'question-1',
  toolUseId: 'tool-question',
  questions: [{ question: 'RAW_QUESTION_中文', options: [{ label: 'RAW_OPTION_中文' }] }],
} satisfies UserQuestionRequestEvent;

const sandboxBoundaryRequest = {
  id: 'event-boundary',
  turnId: 'turn-1',
  ts: 1,
  type: 'sandbox_boundary_request',
  requestId: 'boundary-1',
  toolUseId: 'tool-boundary',
  justification: 'RAW_JUSTIFICATION_中文',
  expansion: {
    filesystem: {
      entries: [
        { path: '/RAW/exact', access: 'read', scope: 'exact' },
        { path: '/RAW/subtree', access: 'write', scope: 'subtree' },
      ],
    },
    network: { enabled: true },
  },
} satisfies SandboxBoundaryRequestEvent;

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
  it('keeps Astryx message semantics in the active locale', () => {
    const surface = (
      <TurnView
        turn={{
          turnId: 'turn-localized',
          status: 'completed',
          partialOutputRetained: false,
          user: { id: 'user-1', role: 'user', text: 'hello' },
          assistant: { id: 'assistant-1', role: 'assistant', text: 'hi' },
          tools: [],
          timeline: [{ kind: 'text', text: 'hi', messageId: 'assistant-1' }],
          notes: [{ id: 'system-1', role: 'system', text: 'notice' }],
          startedAt: 1,
        }}
      />
    );
    const zh = render('zh', surface);
    const en = render('en', surface);

    for (const label of ['你发送的消息', '系统消息', 'Maka 的回答']) {
      assert.match(zh, new RegExp(`aria-label="${label}"`));
    }
    for (const label of ['Your message', 'System message', "Maka's response"]) {
      assert.match(en, new RegExp(`aria-label="${label.replace("'", '&#x27;')}"`));
    }
    assert.doesNotMatch(zh, /Message from (?:user|assistant|system)/);
  });

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
    // ChatComposerInput paints it as an aria-hidden overlay, not a `placeholder`
    // attribute, so match the rendered text.
    assert.match(zh, /aria-hidden="true">描述任务，@ 引用文件，\/ 选择技能…</);
    assert.match(zh, /aria-label="发送"/);
    assert.match(en, /aria-label="Start a conversation"/);
    assert.match(en, /aria-hidden="true">Describe a task, @ to reference files, \/ for skills…</);
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
    // Disabled Send carries the explanatory tooltip (not the neutral 发送
    // label). #1565 PR 3: the Astryx Button renders the tooltip as a popover
    // element and keeps a tooltip'd disabled button focusable via
    // aria-disabled, so the hint stays reachable for keyboard users.
    assert.match(withHint, /type="submit"[^>]*aria-disabled="true"/);
    assert.match(withHint, /role="tooltip"[^>]*>[^]*?先添加一个模型连接才能发送。/);
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

  it('keeps Plan Mode out of the toolbar and reachable from the plus menu (#1433)', () => {
    const markup = render(
      'zh',
      <Composer onSend={() => {}} onStop={() => {}} onPickAttachments={() => {}} onPlanModeChange={() => {}} />,
    );
    // The toolbar no longer carries a standalone Plan switch…
    assert.doesNotMatch(markup, /maka-composer-plan-mode-control/);
    // …but the ＋ menu is present so the mode stays reachable.
    assert.match(markup, /maka-composer-plus-menu/);
    assert.match(markup, /aria-label="添加上下文"/);
  });

  it('keeps the plus menu available when only mode switches are wired', () => {
    const markup = render('zh', <Composer onSend={() => {}} onStop={() => {}} onPlanModeChange={() => {}} />);
    assert.match(markup, /maka-composer-plus-menu/);
    assert.doesNotMatch(markup, /maka-composer-plan-mode-control/);
  });

  it('collapses upload, modes and skills into the plus menu (quiet composer)', () => {
    const markup = render(
      'zh',
      <Composer
        onSend={() => {}}
        onStop={() => {}}
        onPickAttachments={() => {}}
        onPlanModeChange={() => {}}
        mentionSkills={[{ id: 'skill-a', name: '技能 A', description: '描述 A' }]}
      />,
    );
    // One ＋ menu owns attach / skills / modes — no standalone toolbar triggers.
    assert.match(markup, /maka-composer-plus-menu/);
    assert.match(markup, /aria-label="添加上下文"/);
    assert.doesNotMatch(markup, /maka-composer-upload-button/);
    assert.doesNotMatch(markup, /maka-composer-modes-menu/);
    // Menu contents are in the SSR tree for the open popover host.
    // Modes are single menuitemcheckbox rows (not nested Switch controls).
    assert.match(markup, /添加文件或目录/);
    assert.match(markup, /选择技能/);

    // The Skills entry writes `/` into the draft, so with nothing to write it is
    // disabled — and answered on screen. A grey row with no reason tells the
    // user nothing, and a reason only assistive tech can read does not reach
    // them. It used to be reachable: choosing it left a stray `/` behind and
    // opened an empty menu whose light dismiss then ate the next footer click.
    const noSkills = render(
      'zh',
      <Composer onSend={() => {}} onStop={() => {}} mentionSkills={[]} />,
    );
    assert.match(noSkills, /当前没有可用技能/);
    assert.match(noSkills, /aria-disabled="true"[^>]*role="menuitem"/);
    assert.match(markup, /role="menuitemcheckbox"/);
    assert.match(markup, /aria-checked="false"/);
    assert.doesNotMatch(markup, /role="switch"/);

    const en = render(
      'en',
      <Composer
        onSend={() => {}}
        onStop={() => {}}
        onPickAttachments={() => {}}
        onPlanModeChange={() => {}}
        mentionSkills={[]}
      />,
    );
    assert.match(en, /aria-label="Add context"/);
    assert.match(en, /Add file or directory/);
  });

  it('disables attach inside plus while streaming but keeps the plus menu reachable', () => {
    const markup = render(
      'zh',
      <Composer
        onSend={() => {}}
        onStop={() => {}}
        streaming
        onPickAttachments={() => {}}
        onPlanModeChange={() => {}}
      />,
    );
    // Plus menu stays usable mid-turn (#1444).
    assert.match(markup, /maka-composer-plus-menu/);
    assert.match(markup, /aria-label="添加上下文"/);
    // Attach row is disabled rather than removed.
    assert.match(markup, /aria-disabled="true"[^>]*>[\s\S]*?添加文件或目录|添加文件或目录[\s\S]*?aria-disabled="true"/);
  });

  it('marks Plan on the footer toolbar only while Plan is active', () => {
    const on = render(
      'zh',
      <Composer onSend={() => {}} onStop={() => {}} planModeActive onPlanModeChange={() => {}} />,
    );
    assert.match(on, /data-mode="plan"/);
    assert.match(on, /Plan 模式已启用/);
    assert.match(on, /maka-composer-mode-button/);
    assert.match(on, /aria-label="Plan"/);

    const off = render('zh', <Composer onSend={() => {}} onStop={() => {}} onPlanModeChange={() => {}} />);
    assert.doesNotMatch(off, /data-mode=/);
  });

  it('keeps the active-mode mark visible but inert with its reason while streaming', () => {
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
    assert.match(markup, /data-mode="swarm"/);
    // Scope to the mark's own <button>: the same reason also reaches the ＋
    // menu's aria-description, so a document-wide search would pass on that
    // alone. Astryx renders a tooltip'd disabled button as aria-disabled — it
    // stays focusable precisely so the reason remains reachable — never as the
    // native attribute, so that is the one form to pin.
    const at = markup.indexOf('data-mode="swarm"');
    const mark = markup.slice(markup.lastIndexOf('<button', at), markup.indexOf('</button>', at));
    assert.match(mark, /aria-disabled="true"/);
    // …and the reason is what the button actually points at, rather than some
    // other element on the page that happens to carry the same string.
    const describedBy = /aria-describedby="([^"]+)"/.exec(mark)?.[1];
    assert.ok(describedBy, 'a disabled mark must name its reason');
    const tooltip = markup.slice(markup.indexOf(`id="${describedBy}"`));
    assert.match(tooltip.slice(0, tooltip.indexOf('</div></div>')), /等待流式输出结束/);
  });

  it('localizes the active Graph Mode tooltip', () => {
    const zh = render(
      'zh',
      <Composer
        onSend={() => {}}
        onStop={() => {}}
        graphModeActive
        onGraphModeChange={() => {}}
      />,
    );
    const en = render(
      'en',
      <Composer
        onSend={() => {}}
        onStop={() => {}}
        graphModeActive
        onGraphModeChange={() => {}}
      />,
    );
    assert.match(zh, /Graph 模式已启用/);
    assert.match(en, /Graph mode is on/);
  });

  it('keeps the plus menu reachable while streaming (#1444)', () => {
    const markup = render(
      'zh',
      <Composer
        onSend={() => {}}
        onStop={() => {}}
        streaming
        onPickAttachments={() => {}}
        onPlanModeChange={() => {}}
        onSwarmModeChange={() => {}}
      />,
    );
    // The ＋ menu must stay mounted mid-turn so Plan/Swarm remain
    // reachable (attach itself stays disabled mid-stream).
    assert.match(markup, /maka-composer-plus-menu/);
    assert.match(markup, /aria-label="添加上下文"/);
  });

  it('keeps Swarm Mode out of the toolbar (#1433)', () => {
    const markup = render(
      'zh',
      <Composer onSend={() => {}} onStop={() => {}} onPickAttachments={() => {}} onSwarmModeChange={() => {}} />,
    );
    assert.doesNotMatch(markup, /maka-composer-swarm-mode-control/);
    assert.match(markup, /maka-composer-plus-menu/);
  });

  it('localizes question chrome while preserving raw values', () => {
    const surface = (
      <UserQuestionPrompt request={questionRequest} onRespond={() => {}} onStop={() => {}} />
    );
    const zh = render('zh', surface);
    const en = render('en', surface);

    assert.match(en, /Other/);
    for (const raw of ['RAW_QUESTION_中文', 'RAW_OPTION_中文']) {
      assert.match(zh, new RegExp(raw));
      assert.match(en, new RegExp(raw));
    }
  });

  it('localizes sandbox boundary chrome while preserving exact requested scopes', () => {
    const surface = <SandboxBoundaryPrompt request={sandboxBoundaryRequest} onRespond={() => {}} />;
    const zh = render('zh', surface);
    const en = render('en', surface);

    assert.match(zh, /允许访问工作区以外的内容？/);
    assert.match(zh, /读取 · 仅此路径/);
    assert.match(zh, /写入 · 目录及子目录/);
    assert.match(zh, /网络访问/);
    assert.match(zh, /本会话允许/);
    assert.match(en, /Allow access outside the workspace\?/);
    assert.match(en, /Read · Exact path/);
    assert.match(en, /Write · Directory subtree/);
    assert.match(en, /Network access/);
    assert.match(en, /Allow for this session/);
    for (const raw of ['RAW_JUSTIFICATION_中文', '/RAW/exact', '/RAW/subtree']) {
      assert.match(zh, new RegExp(raw));
      assert.match(en, new RegExp(raw));
    }
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
      /maka-list-group-label|maka-list-group-toggle|maka-list-group-count/,
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
