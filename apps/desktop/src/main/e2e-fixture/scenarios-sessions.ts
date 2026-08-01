import type { SessionHeader, StoredMessage } from '@maka/core';
import {
  header,
  HEALTHY_SESSION_ID,
  LONG_SIDEBAR_SESSION_COUNT,
  LONG_SIDEBAR_SESSION_PREFIX,
  LONG_TRANSCRIPT_SESSION_ID,
  STALE_FAKE_SESSION_ID,
  STALE_LEGACY_SESSION_ID,
  TURN_CONTROL_BRANCH_ORPHAN_SESSION_ID,
  TURN_CONTROL_BRANCH_VISIBLE_SESSION_ID,
  TURN_CONTROL_ORPHAN_PARENT_ID,
  TURN_CONTROL_PRIMARY_SESSION_ID,
  WORKSTATION_ABORTED_SESSION_ID,
  WORKSTATION_ACTIVE_SESSION_ID,
  WORKSTATION_ARCHIVED_SESSION_ID,
  WORKSTATION_BLOCKED_AUTH_SESSION_ID,
  WORKSTATION_BLOCKED_PERM_SESSION_ID,
  WORKSTATION_BLOCKED_TOOL_SESSION_ID,
  WORKSTATION_BLOCKED_UNKNOWN_SESSION_ID,
  WORKSTATION_DONE_SESSION_ID,
  WORKSTATION_REVIEW_SESSION_ID,
  WORKSTATION_RUNNING_SESSION_ID,
  WORKSTATION_WAITING_SESSION_ID,
} from './seed-helpers.js';

export function longTranscriptSession(now: number): SessionHeader {
  return header({
    id: LONG_TRANSCRIPT_SESSION_ID,
    name: '超长会话滚动几何',
    connection: 'zai-live',
    model: 'glm-5.1',
    orchestrationMode: 'graph',
    now,
    lastMessageAt: now - 5 * 60_000,
  });
}

/**
 * 24 turns, each ~1300px tall once rendered, so the transcript is ~25x the
 * 250px contain-intrinsic-size placeholder per turn and dozens of viewports
 * tall overall. Plain text on purpose: the contract under test is scroll
 * geometry, not markdown rendering.
 */
export function longTranscriptMessages(now: number): StoredMessage[] {
  const filler = Array.from(
    { length: 60 },
    (_, line) => `第 ${line + 1} 行 — 用于撑高单个 turn 的占位正文内容。`,
  ).join('  \n');
  const messages: StoredMessage[] = [];
  const base = now - 60 * 60_000;
  for (let turn = 0; turn < 24; turn++) {
    const turnId = `long-transcript-turn-${turn}`;
    messages.push({
      type: 'user',
      id: `long-transcript-user-${turn}`,
      turnId,
      ts: base + turn * 60_000,
      text: `长会话问题 ${turn + 1}`,
    });
    messages.push({
      type: 'assistant',
      id: `long-transcript-assistant-${turn}`,
      turnId,
      ts: base + turn * 60_000 + 30_000,
      text: `长会话回答 ${turn + 1}\n\n${filler}`,
      modelId: 'glm-5.1',
    });
  }
  return messages;
}

/**
 * PR109b workstation-statuses fixture seed. Returns one session per
 * SessionStatus group + 4 blocked sub-rows (one per
 * SessionBlockedReason), pre-staged with a brief 2-message history so
 * the sidebar `lastMessagePreview` renders something realistic.
 *
 * Order in the array doesn't matter — the renderer's grouping helper
 * places them in the locked group order regardless. The active
 * session (`WORKSTATION_RUNNING_SESSION_ID`) is chosen as the running
 * one so the chat header status badge ("进行中") shows in the
 * screenshot alongside the sidebar grouping.
 */
export function workstationStatusSessions(now: number): Array<{ header: SessionHeader; messages: StoredMessage[] }> {
  const baseLastMessage = now - 2 * 60 * 1000;
  const make = (input: {
    id: string;
    name: string;
    status: SessionHeader['status'];
    blockedReason?: SessionHeader['blockedReason'];
    isArchived?: boolean;
    isFlagged?: boolean;
    lastMessageOffset: number;
  }): { header: SessionHeader; messages: StoredMessage[] } => ({
    header: header({
      id: input.id,
      name: input.name,
      connection: 'zai-live',
      model: 'glm-5.1',
      now,
      lastMessageAt: baseLastMessage - input.lastMessageOffset,
      status: input.status,
      ...(input.blockedReason ? { blockedReason: input.blockedReason } : {}),
      ...(input.isArchived !== undefined ? { isArchived: input.isArchived } : {}),
      ...(input.isFlagged !== undefined ? { isFlagged: input.isFlagged } : {}),
    }),
    messages: [
      {
        type: 'user',
        id: `${input.id}-user`,
        turnId: `${input.id}-turn`,
        ts: baseLastMessage - input.lastMessageOffset - 10_000,
        text: `请把「${input.name}」这条工作流的当前状态整理成可交接摘要。`,
      },
      {
        type: 'assistant',
        id: `${input.id}-assistant`,
        turnId: `${input.id}-turn`,
        ts: baseLastMessage - input.lastMessageOffset,
        text: '已记录关键状态、下一步动作和需要人工确认的风险点。',
        modelId: 'glm-5.1',
      },
    ],
  });
  return [
    make({ id: WORKSTATION_RUNNING_SESSION_ID, name: '正在生成报告', status: 'running', lastMessageOffset: 1_000 }),
    make({ id: WORKSTATION_WAITING_SESSION_ID, name: '等你确认权限', status: 'waiting_for_user', lastMessageOffset: 60_000 }),
    make({
      id: WORKSTATION_BLOCKED_AUTH_SESSION_ID,
      name: 'GPT-5 鉴权失败',
      status: 'blocked',
      blockedReason: 'auth',
      lastMessageOffset: 120_000,
    }),
    make({
      id: WORKSTATION_BLOCKED_PERM_SESSION_ID,
      name: '等待权限批准',
      status: 'blocked',
      blockedReason: 'permission_required',
      lastMessageOffset: 180_000,
    }),
    make({
      id: WORKSTATION_BLOCKED_TOOL_SESSION_ID,
      name: '工具调用失败',
      status: 'blocked',
      blockedReason: 'tool_failed',
      lastMessageOffset: 240_000,
    }),
    make({
      id: WORKSTATION_BLOCKED_UNKNOWN_SESSION_ID,
      name: '运行中断',
      status: 'blocked',
      blockedReason: 'unknown',
      lastMessageOffset: 300_000,
    }),
    make({ id: WORKSTATION_ACTIVE_SESSION_ID, name: '可继续的会话', status: 'active', lastMessageOffset: 360_000 }),
    make({ id: WORKSTATION_REVIEW_SESSION_ID, name: '待审核的长任务输出', status: 'review', lastMessageOffset: 420_000 }),
    make({ id: WORKSTATION_DONE_SESSION_ID, name: '完成并已审核', status: 'done', lastMessageOffset: 480_000 }),
    make({
      id: WORKSTATION_ARCHIVED_SESSION_ID,
      name: '归档的旧会话',
      status: 'archived',
      isArchived: true,
      lastMessageOffset: 7 * 24 * 60 * 60 * 1000,
    }),
    // @kenji PR109b review: aborted must be visible (collapsed group).
    // Seed one so the fixture covers the dormant-but-visible state.
    make({
      id: WORKSTATION_ABORTED_SESSION_ID,
      name: '已中止的会话',
      status: 'aborted',
      lastMessageOffset: 14 * 24 * 60 * 60 * 1000,
    }),
  ];
}

/**
 * PR109f (g) turn-control-history fixture seed. Returns three sessions
 * sharing the same on-disk state:
 *
 *  - `primary` — full turn list covering completed / aborted / failed +
 *    retry pair + regenerate pair. Used to verify the lineage badges
 *    (forward + reverse), aborted "(已中断)" marker, and failed-turn
 *    generalized Chinese banner copy.
 *  - `branch-visible` — parentSessionId points to primary, so the chat
 *    header should render "分自 ${primary.name}" when this session is
 *    active.
 *  - `branch-orphan` — parentSessionId points to a session id that is
 *    NOT seeded; renderer's `deriveBranchBanner()` returns undefined
 *    and no banner is rendered (negative screenshot case).
 *
 * The three are interchangeable for screenshot purposes — only the
 * active session selection in `applyScenarioOverrides` decides which
 * one is rendered in the chat surface.
 */
export function turnControlSessions(now: number): Array<{ header: SessionHeader; messages: StoredMessage[] }> {
  const primaryHeader = header({
    id: TURN_CONTROL_PRIMARY_SESSION_ID,
    name: '回合控制示例（原会话）',
    connection: 'zai-live',
    model: 'glm-5.1',
    now,
    lastMessageAt: now - 2 * 60_000,
    status: 'active',
  });

  const branchVisibleHeader = header({
    id: TURN_CONTROL_BRANCH_VISIBLE_SESSION_ID,
    name: '从原会话分出的探索',
    connection: 'zai-live',
    model: 'glm-5.1',
    now,
    lastMessageAt: now - 60_000,
    status: 'active',
  });
  branchVisibleHeader.parentSessionId = TURN_CONTROL_PRIMARY_SESSION_ID;
  branchVisibleHeader.branchOfTurnId = 'turn-retry-origin';

  const branchOrphanHeader = header({
    id: TURN_CONTROL_BRANCH_ORPHAN_SESSION_ID,
    name: '父会话已删除的分支',
    connection: 'zai-live',
    model: 'glm-5.1',
    now,
    lastMessageAt: now - 30_000,
    status: 'active',
  });
  // Intentionally references a session id never written to disk so the
  // renderer must render no banner (negative screenshot case).
  branchOrphanHeader.parentSessionId = TURN_CONTROL_ORPHAN_PARENT_ID;
  branchOrphanHeader.branchOfTurnId = 'turn-deleted-origin';

  return [
    { header: primaryHeader, messages: turnControlPrimaryMessages(now) },
    { header: branchVisibleHeader, messages: turnControlBranchMessages(now, 'visible') },
    { header: branchOrphanHeader, messages: turnControlBranchMessages(now, 'orphan') },
  ];
}

/**
 * Primary-session message log covering every turn-control surface in
 * one fixture. The turn IDs are short, human-readable strings so the
 * lineage-badge copy (e.g. "重新生成自 turn turn-ret") stays stable across
 * regenerations.
 *
 * Turns:
 *  1. `turn-baseline`         — user+assistant, completed
 *  2. `turn-aborted`          — user+assistant (partial)+turn_state(aborted)
 *  3. `turn-retry-origin`     — user+assistant, completed (origin of retry)
 *  4. `turn-retry-new`        — user+assistant, completed; retriedFromTurnId = origin
 *  5. `turn-regen-origin`     — user+assistant, completed (origin of regenerate)
 *  6. `turn-regen-new`        — user+assistant, completed; regeneratedFromTurnId = origin
 *  7. `turn-failed`           — user+assistant (partial)+turn_state(failed, errorClass='timeout')
 *
 * Note: turn_state messages are appended last in each turn bucket so
 * `deriveTurnRecords()` reads the final status correctly.
 */
function turnControlPrimaryMessages(now: number): StoredMessage[] {
  const messages: StoredMessage[] = [];
  let cursor = now - 60 * 60_000; // start an hour ago, walk forward

  const tickUser = 10_000;
  const tickAssistant = 15_000;
  const tickState = 1_000;

  // 1. completed baseline
  cursor += tickUser;
  messages.push({
    type: 'user',
    id: 'msg-baseline-user',
    turnId: 'turn-baseline',
    ts: cursor,
    text: '帮我看一下当前回合状态截图覆盖了哪些情况。',
  });
  cursor += tickAssistant;
  messages.push({
    type: 'assistant',
    id: 'msg-baseline-assistant',
    turnId: 'turn-baseline',
    ts: cursor,
    text: '当前展示的是已完成的基础回合，可作为截图基线。',
    modelId: 'glm-5.1',
  });
  cursor += tickState;
  messages.push({
    type: 'turn_state',
    id: 'state-baseline',
    turnId: 'turn-baseline',
    ts: cursor,
    status: 'completed',
    partialOutputRetained: true,
  });

  // 2. aborted (partial assistant text + turn_state=aborted)
  cursor += tickUser;
  messages.push({
    type: 'user',
    id: 'msg-aborted-user',
    turnId: 'turn-aborted',
    ts: cursor,
    text: '执行一个长任务但提前中止。',
  });
  cursor += tickAssistant;
  messages.push({
    type: 'assistant',
    id: 'msg-aborted-assistant',
    turnId: 'turn-aborted',
    ts: cursor,
    text: '正在分析项目结构……',
    modelId: 'glm-5.1',
  });
  cursor += tickState;
  messages.push({
    type: 'turn_state',
    id: 'state-aborted',
    turnId: 'turn-aborted',
    ts: cursor,
    status: 'aborted',
    abortedAt: cursor,
    partialOutputRetained: true,
  });

  // 3. retry origin
  cursor += tickUser;
  messages.push({
    type: 'user',
    id: 'msg-retry-origin-user',
    turnId: 'turn-retry-origin',
    ts: cursor,
    text: '生成一份初稿。',
  });
  cursor += tickAssistant;
  messages.push({
    type: 'assistant',
    id: 'msg-retry-origin-assistant',
    turnId: 'turn-retry-origin',
    ts: cursor,
    text: '初稿 v1。',
    modelId: 'glm-5.1',
  });
  cursor += tickState;
  messages.push({
    type: 'turn_state',
    id: 'state-retry-origin',
    turnId: 'turn-retry-origin',
    ts: cursor,
    status: 'completed',
    partialOutputRetained: true,
  });

  // 4. retry new (forward "重新生成自 turn-retry-origin" + reverse "已重新生成 → turn-retry-new")
  cursor += tickUser;
  messages.push({
    type: 'user',
    id: 'msg-retry-new-user',
    turnId: 'turn-retry-new',
    ts: cursor,
    text: '再生成一遍。',
  });
  cursor += tickAssistant;
  messages.push({
    type: 'assistant',
    id: 'msg-retry-new-assistant',
    turnId: 'turn-retry-new',
    ts: cursor,
    text: '初稿 v2，包含修订建议。',
    modelId: 'glm-5.1',
  });
  cursor += tickState;
  messages.push({
    type: 'turn_state',
    id: 'state-retry-new',
    turnId: 'turn-retry-new',
    ts: cursor,
    status: 'completed',
    retriedFromTurnId: 'turn-retry-origin',
    partialOutputRetained: true,
  });

  // 5. regenerate origin
  cursor += tickUser;
  messages.push({
    type: 'user',
    id: 'msg-regen-origin-user',
    turnId: 'turn-regen-origin',
    ts: cursor,
    text: '换个角度回答。',
  });
  cursor += tickAssistant;
  messages.push({
    type: 'assistant',
    id: 'msg-regen-origin-assistant',
    turnId: 'turn-regen-origin',
    ts: cursor,
    text: '答案 A（保留供对比）。',
    modelId: 'glm-5.1',
  });
  cursor += tickState;
  messages.push({
    type: 'turn_state',
    id: 'state-regen-origin',
    turnId: 'turn-regen-origin',
    ts: cursor,
    status: 'completed',
    partialOutputRetained: true,
  });

  // 6. regenerate new
  cursor += tickUser;
  messages.push({
    type: 'user',
    id: 'msg-regen-new-user',
    turnId: 'turn-regen-new',
    ts: cursor,
    text: '再生成一个并行回答。',
  });
  cursor += tickAssistant;
  messages.push({
    type: 'assistant',
    id: 'msg-regen-new-assistant',
    turnId: 'turn-regen-new',
    ts: cursor,
    text: '答案 B（与答案 A 并列）。',
    modelId: 'glm-5.1',
  });
  cursor += tickState;
  messages.push({
    type: 'turn_state',
    id: 'state-regen-new',
    turnId: 'turn-regen-new',
    ts: cursor,
    status: 'completed',
    regeneratedFromTurnId: 'turn-regen-origin',
    partialOutputRetained: true,
  });

  // 7. failed (errorClass='timeout' → generalized copy "请求超时")
  cursor += tickUser;
  messages.push({
    type: 'user',
    id: 'msg-failed-user',
    turnId: 'turn-failed',
    ts: cursor,
    text: '运行一个长查询。',
  });
  cursor += tickAssistant;
  messages.push({
    type: 'assistant',
    id: 'msg-failed-assistant',
    turnId: 'turn-failed',
    ts: cursor,
    text: '开始查询数据……',
    modelId: 'glm-5.1',
  });
  cursor += tickState;
  messages.push({
    type: 'turn_state',
    id: 'state-failed',
    turnId: 'turn-failed',
    ts: cursor,
    status: 'failed',
    errorClass: 'timeout',
    partialOutputRetained: true,
  });

  return messages;
}

/**
 * Minimal message log for branch sessions. Branches start with a
 * single completed turn so the chat surface has visible content, but
 * we don't reproduce every parent turn (that would defeat the point of
 * the fixture — banner-vs-no-banner is the contract under test).
 */
function turnControlBranchMessages(now: number, kind: 'visible' | 'orphan'): StoredMessage[] {
  const turnId = `turn-${kind}-branch`;
  const userText = kind === 'visible'
    ? '在分支会话里继续这条思路。'
    : '父会话已经被删除，但分支自身还在。';
  const assistantText = kind === 'visible'
    ? '已切到分支会话。点击顶部 banner 可以跳回原会话。'
    : '分支保留了本地内容，但跳回链接已失效。';
  return [
    {
      type: 'user',
      id: `msg-${kind}-user`,
      turnId,
      ts: now - 2 * 60_000,
      text: userText,
    },
    {
      type: 'assistant',
      id: `msg-${kind}-assistant`,
      turnId,
      ts: now - 90_000,
      text: assistantText,
      modelId: 'glm-5.1',
    },
    {
      type: 'turn_state',
      id: `state-${kind}-branch`,
      turnId,
      ts: now - 89_000,
      status: 'completed',
      partialOutputRetained: true,
    },
  ];
}

/**
 * PR-SIDEBAR-IA-0 Phase 1: long sidebar fixture.
 *
 * Seeds `LONG_SIDEBAR_SESSION_COUNT` (60) sessions so the sidebar
 * scroll fix is verifiable end-to-end:
 *
 *   - In a narrow window, the list must scroll without pushing the
 *     footer (Settings + Version info) off-screen.
 *   - The inner `.maka-list-stack` scroll container must engage.
 *   - The fixture is deterministic: titles only differ by index;
 *     timestamps walk backwards from `now` so the FIRST session
 *     (`...-00`) is the newest and gets sorted to the top.
 *
 * Each session contains a single short user/assistant exchange so
 * the message file is well-formed but visually inert. The screenshot
 * baseline focuses on the sidebar, not the chat surface.
 */
export function longSidebarSessions(now: number): Array<{ header: SessionHeader; messages: StoredMessage[] }> {
  const seeds: Array<{ header: SessionHeader; messages: StoredMessage[] }> = [];
  for (let i = 0; i < LONG_SIDEBAR_SESSION_COUNT; i++) {
    const idSuffix = String(i).padStart(2, '0');
    const sessionId = LONG_SIDEBAR_SESSION_PREFIX + idSuffix;
    // First session is newest; subsequent walk backwards in 5-minute
    // increments so the sort is stable and predictable.
    const lastMessageAt = now - i * 5 * 60_000;
    const sessionHeader = header({
      id: sessionId,
      name: '会话 ' + idSuffix,
      connection: 'zai-live',
      model: 'glm-5.1',
      now,
      lastMessageAt,
      status: 'active',
    });
    const userTs = lastMessageAt - 30_000;
    const assistantTs = lastMessageAt;
    const messages: StoredMessage[] = [
      {
        type: 'user',
        id: 'msg-long-user-' + idSuffix,
        turnId: 'turn-long-' + idSuffix,
        ts: userTs,
        text: '示例对话 ' + idSuffix,
      },
      {
        type: 'assistant',
        id: 'msg-long-assistant-' + idSuffix,
        turnId: 'turn-long-' + idSuffix,
        ts: assistantTs,
        text: '已把第 ' + idSuffix + ' 条研究记录归档到当前工作流，侧边栏应保持稳定滚动位置。',
        modelId: 'glm-5.1',
      },
    ];
    seeds.push({ header: sessionHeader, messages });
  }
  return seeds;
}

// Stale-sessions fixture seeds three sessions reproducing the on-disk
// state that triggered the P0 (WAWQAQ workspace had `fake-claude` +
// `backend=fake` sessions sitting next to a healthy `zai-coding-plan`
// one). Locks the @kenji active-stale pill gate (active session is
// intentionally one of the stale ones).
export function staleFakeSession(now: number): SessionHeader {
  return header({
    id: STALE_FAKE_SESSION_ID,
    name: '旧的本地模拟会话',
    connection: 'fake',
    model: 'fake-model',
    now,
    lastMessageAt: now - 4 * 24 * 3_600_000,
    backend: 'fake',
    connectionLocked: false,
  });
}

export function staleLegacySession(now: number): SessionHeader {
  return header({
    id: STALE_LEGACY_SESSION_ID,
    name: '旧的 Claude 连接会话',
    connection: 'fake-claude',
    model: 'claude-3-sonnet',
    now,
    lastMessageAt: now - 7 * 24 * 3_600_000,
    backend: 'claude' as SessionHeader['backend'],
    connectionLocked: true,
  });
}

export function healthySession(now: number): SessionHeader {
  return header({
    id: HEALTHY_SESSION_ID,
    name: '正常会话（Z.ai Live）',
    connection: 'zai-live',
    model: 'glm-5.1',
    now,
    lastMessageAt: now - 12 * 60_000,
    backend: 'ai-sdk',
  });
}

export function staleFakeMessages(now: number): StoredMessage[] {
  const turnId = 'stale-fake-turn-1';
  return [
    {
      type: 'user',
      id: 'stale-fake-msg-1',
      turnId,
      ts: now - 4 * 24 * 3_600_000,
      text: '这是旧的本地模拟会话，发送时应该会切换到当前默认连接。',
    },
    {
      type: 'assistant',
      id: 'stale-fake-msg-2',
      turnId,
      ts: now - 4 * 24 * 3_600_000 + 2_000,
      text: '这是旧的本地模拟会话留下的回复文本。',
      modelId: 'fake-model',
    },
  ];
}

export function staleLegacyMessages(now: number): StoredMessage[] {
  const turnId = 'stale-legacy-turn-1';
  return [
    {
      type: 'user',
      id: 'stale-legacy-msg-1',
      turnId,
      ts: now - 7 * 24 * 3_600_000,
      text: '这是历史 Claude 连接留下的会话。原连接 fake-claude 已不在连接列表里。',
    },
    {
      type: 'assistant',
      id: 'stale-legacy-msg-2',
      turnId,
      ts: now - 7 * 24 * 3_600_000 + 3_000,
      text: '这条历史会话需要切换到当前可用模型后才能继续发送。',
      modelId: 'claude-3-sonnet',
    },
  ];
}

export function healthyMessages(now: number): StoredMessage[] {
  const turnId = 'healthy-turn-1';
  return [
    {
      type: 'user',
      id: 'healthy-msg-1',
      turnId,
      ts: now - 12 * 60_000,
      text: '这是正常的 ai-sdk + zai-live 会话，sidebar 应该没有 "已过期" pill。',
    },
    {
      type: 'assistant',
      id: 'healthy-msg-2',
      turnId,
      ts: now - 12 * 60_000 + 1_500,
      text: '当前连接健康，后续发送会继续使用这个会话固定的 GLM 模型。',
      modelId: 'glm-5.1',
    },
  ];
}
