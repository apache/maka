import { join } from 'node:path';
import type {
  DailyReviewArchive,
  LlmConnection,
  E2eFixtureScenario,
} from '@maka/core';
import { createDefaultSettings } from '@maka/core/settings';
import { createSqlitePlanReminderStore } from '@maka/storage';
import { writeJson } from './seed-helpers.js';
import { createDailyReviewArchiveStore } from '../daily-review-archive-store.js';

export async function writeSettings(
  workspaceRoot: string,
  scenario?: E2eFixtureScenario,
): Promise<void> {
  // PR-SIDEBAR-IA-0 Phase 3 P0 fixup v2 (kenji `08be08d8` + WAWQAQ
  // `1886c41b`): the fixture previously seeded a placeholder
  // Chinese personal name for deterministic rendering, but a real
  // user reading the chat surface can't tell who that placeholder
  // is. Worse, if a demo workspace was ever opened on top of a
  // real user's workspace, the placeholder would persist and
  // confuse them about who set it.
  //
  // Phase 3 fixup v2 leaves `displayName` empty so screenshots and
  // Settings match a new, unconfigured user. Settings test
  // (`e2e-fixture.test.ts`) asserts the empty-string value
  // so a future patch that re-adds a demo name lands as an explicit
  // copy decision, not silent drift.
  const settings = createDefaultSettings();
  settings.personalization.displayName = '';
  settings.appearance.theme = 'auto';
  // Settings → 使用统计: the seeded traffic uses the fixed e2e-fixture clock,
  // which sits outside the real-time 24h/7天/30天 windows the store derives
  // from Date.now(). Default the usage view to 全部 + details-on so the
  // capture shows the populated request log and stats tables deterministically.
  if (scenario === 'settings-usage') {
    settings.usage.range = 'all';
    settings.usage.showDetails = true;
  }
  await writeJson(join(workspaceRoot, 'settings.json'), settings);
}

export async function writeConnections(workspaceRoot: string, now: number, scenario: E2eFixtureScenario): Promise<void> {
  const connections: LlmConnection[] = [
    {
      slug: 'zai-live',
      name: 'Z.ai Live Fixture',
      providerType: 'zai-coding-plan',
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      defaultModel: 'glm-5.1',
      enabled: true,
      models: [
        model('glm-4.5', { functionCalling: true }, 128_000),
        model('glm-4.5-air', { functionCalling: true }, 128_000),
        model('glm-4.6', { reasoning: true, functionCalling: true }, 200_000),
        model('glm-4.7', { reasoning: true, functionCalling: true }, 200_000),
        model('glm-5', { reasoning: true, functionCalling: true }, 200_000),
        model('glm-5-turbo', { reasoning: true, functionCalling: true }, 200_000),
        model('glm-5.1', { vision: true, reasoning: true, functionCalling: true }, 1_000_000),
      ],
      modelSource: 'fetched',
      modelsFetchedAt: now - 5 * 60_000,
      lastTestStatus: 'verified',
      lastTestAt: new Date(now - 4 * 60_000).toISOString(),
      lastTestMessage: '连接已验证',
      createdAt: now - 3_600_000,
      updatedAt: now - 4 * 60_000,
    },
    {
      slug: 'relay-fallback',
      name: 'Fallback Relay Fixture',
      providerType: 'openai-compatible',
      baseUrl: 'https://relay.example.test/v1',
      defaultModel: 'relay-static-model',
      enabled: true,
      modelSource: 'fallback',
      createdAt: now - 3_500_000,
      updatedAt: now - 3_500_000,
    },
    {
      slug: 'empty-fetched',
      name: 'Fetched Empty Fixture',
      providerType: 'openai-compatible',
      baseUrl: 'https://empty.example.test/v1',
      defaultModel: 'empty-placeholder',
      enabled: true,
      models: [],
      modelSource: 'fetched',
      modelsFetchedAt: now - 15 * 60_000,
      lastTestStatus: 'verified',
      lastTestAt: new Date(now - 15 * 60_000).toISOString(),
      lastTestMessage: '连接已验证',
      createdAt: now - 3_400_000,
      updatedAt: now - 15 * 60_000,
    },
    {
      slug: 'needs-reauth',
      name: 'Needs Reauth Fixture',
      providerType: 'anthropic',
      defaultModel: 'claude-sonnet-4-5-20250929',
      enabled: true,
      models: [model('claude-sonnet-4-5-20250929', { vision: true, reasoning: true, functionCalling: true }, 200_000)],
      modelSource: 'fetched',
      modelsFetchedAt: now - 3 * 3_600_000,
      lastTestStatus: 'needs_reauth',
      lastTestAt: new Date(now - 10 * 60_000).toISOString(),
      lastTestMessage: '鉴权失败',
      createdAt: now - 3_300_000,
      updatedAt: now - 10 * 60_000,
    },
    {
      slug: 'broken-provider',
      name: 'Broken Provider Fixture',
      providerType: 'openai',
      defaultModel: 'gpt-4o-mini',
      enabled: true,
      models: [model('gpt-4o-mini', { vision: true, functionCalling: true }, 128_000)],
      modelSource: 'fetched',
      modelsFetchedAt: now - 4 * 3_600_000,
      lastTestStatus: 'error',
      lastTestAt: new Date(now - 8 * 60_000).toISOString(),
      lastTestMessage: '模型服务返回错误',
      createdAt: now - 3_200_000,
      updatedAt: now - 8 * 60_000,
    },
  ];
  if (scenario === 'oauth-relogin') {
    // A openai-codex (OAuth) connection whose last test came back
    // needs_reauth. Its detail sheet must offer an inline 登录 / 重新登录
    // button (driven by the shared OAuth login flow) instead of the old dead
    // prose. Credential presence for OAuth connections is resolved through the
    // subscription token store (empty here), so the button reads 登录; the
    // hasSecret===true → 重新登录 label is pinned by the detail-sheet contract.
    connections.push({
      slug: 'codex-subscription',
      name: 'OpenAI Codex Fixture',
      providerType: 'openai-codex',
      defaultModel: 'gpt-5.5',
      enabled: true,
      models: [model('gpt-5.5', { reasoning: true, functionCalling: true }, 200_000)],
      modelSource: 'fetched',
      modelsFetchedAt: now - 6 * 60_000,
      lastTestStatus: 'needs_reauth',
      lastTestAt: new Date(now - 6 * 60_000).toISOString(),
      lastTestMessage: '需要重新登录',
      createdAt: now - 3_100_000,
      updatedAt: now - 6 * 60_000,
    });
  }
  const focusSlug = connectionFocusSlug(scenario);
  const ordered = focusSlug
    ? [
        ...connections.filter((connection) => connection.slug === focusSlug),
        ...connections.filter((connection) => connection.slug !== focusSlug),
      ]
    : connections;
  await writeJson(join(workspaceRoot, 'llm-connections.json'), {
    defaultSlug: focusSlug ?? 'zai-live',
    connections: ordered,
  });
}

function connectionFocusSlug(scenario: E2eFixtureScenario): string | null {
  switch (scenario) {
    case 'fallback-source':
      return 'relay-fallback';
    case 'fetched-empty':
      return 'empty-fetched';
    case 'oauth-relogin':
      return 'codex-subscription';
    case 'connection-error':
      return 'broken-provider';
    default:
      return null;
  }
}

function model(
  id: string,
  capabilities: NonNullable<LlmConnection['models']>[number]['capabilities'],
  contextWindow: number,
): NonNullable<LlmConnection['models']>[number] {
  return { id, capabilities, contextWindow };
}

export async function writePlanReminders(workspaceRoot: string, _now: number): Promise<void> {
  const scheduledRunAt = Date.UTC(2026, 11, 18, 3, 0, 0);
  const pausedRunAt = Date.UTC(2026, 11, 20, 3, 0, 0);
  const store = createSqlitePlanReminderStore(workspaceRoot);
  try {
    await store.create({
      title: '同步项目风险',
      note: '提醒我整理 Sidebar gate、搜索接入和计划任务剩余风险。',
      runAt: scheduledRunAt,
    });
    const paused = await store.create({
      title: '暂停的发布检查',
      note: '用户可以先暂停提醒，恢复后继续按原时间触发。',
      runAt: pausedRunAt,
    });
    await store.setEnabled(paused.id, false);
    const weekly = await store.create({
      title: '每周竞品动态追踪',
      note: '汇总同类 AI 工具的近期产品变化，提醒我复盘可对标的交互。',
      runAt: scheduledRunAt,
      recurrence: 'cron',
      cronExpression: '0 10 * * 1',
    });
    await store.markTriggered(weekly.id, {
      at: scheduledRunAt,
      status: 'triggered',
      message: '已生成本周竞品动态摘要',
    });
    const completed = await store.create({
      title: '已触发的本地提醒',
      runAt: scheduledRunAt,
    });
    await store.markTriggered(completed.id, {
      at: scheduledRunAt,
      status: 'triggered',
      message: '计划提醒已触发',
    });
  } finally {
    store.close();
  }
}

export async function writeDailyReviewArchives(workspaceRoot: string, now: number): Promise<void> {
  const dayFromMs = Date.UTC(2026, 4, 21, 0, 0, 0);
  const dayToMs = Date.UTC(2026, 4, 22, 0, 0, 0);
  const daily: DailyReviewArchive = {
    id: '2026-05-21-1d',
    day: { fromMs: dayFromMs, toMs: dayToMs },
    range: 1,
    status: 'ok',
    generatedAt: now - 10 * 60_000,
    trigger: 'manual',
    modelKey: 'zai-live::glm-4.5',
    totals: {
      sessionCount: 8,
      requestCount: 34,
      totalTokens: 128_640,
      costUsd: 1.82,
      errorCount: 1,
    },
    sections: {
      summary: '今天主要围绕 Maka 桌面端的侧边栏、权限中心和每日回顾展开，重点是把入口、报告保存和设置项接到真实运行链路。',
      gaps: '权限中心按钮已经接入系统设置跳转；每日回顾外部通知仍缺少报告自动推送运行时，需要保持不可用状态而不是展示假开关。',
      usage: '模型请求集中在 UI 逆向与合约验证，工具调用以文件检索、构建和截图 smoke 为主。',
      code: '建议继续收敛 Settings 与模块页的 shared page shell，减少同类 surface 在 styles.css 里的重复规则。',
    },
  };
  const deep: DailyReviewArchive = {
    ...daily,
    id: '2026-05-15-7d',
    day: { fromMs: Date.UTC(2026, 4, 15, 0, 0, 0), toMs: dayToMs },
    range: 7,
    generatedAt: now - 5 * 60_000,
    trigger: 'cron',
    totals: {
      ...daily.totals,
      sessionCount: 12,
      requestCount: 58,
      totalTokens: 211_300,
      costUsd: 3.94,
      errorCount: 1,
    },
    sections: {
      summary: '深度分析覆盖最近一轮 Maka UI 打磨：参考布局学习、权限中心重画、Daily Review 从聚合面板走向可保存报告。',
      gaps: '第一性原理层面需要把“模块页 shell / Settings row / 状态 pill / 操作按钮”抽成真实组件，否则后续仍会在 CSS 中继续堆叠局部规则。',
      usage: '高频动作是读取源码、运行 contract、构建 renderer、生成 e2e-fixture 截图。失败成本主要来自多处页面壳层行为不统一。',
      code: '下一步优先建立模块页 PageShell、SettingsActionRow 和 StatusPill primitives，再迁移 Daily Review、权限中心、计划任务和技能页。',
    },
  };
  const store = createDailyReviewArchiveStore(workspaceRoot);
  await store.putArchive(daily);
  await store.putArchive(deep);
}
