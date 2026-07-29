import {
  DAILY_REVIEW_LIST_LIMIT,
  buildDailyReviewSummary,
  collapseSessionRevisions,
  dailyReviewArchiveId,
  dailyUsageQuery,
  generalizedErrorMessageChinese,
  localDayBoundsAt,
  localDayBoundsForInstant,
  pickDailyReviewSessions,
  pickDailyReviewTopEntries,
} from '@maka/core';
import type {
  DailyReviewArchive,
  DailyReviewArchiveSectionContent,
  DailyReviewConfig,
  DailyReviewMode,
  DailyReviewSummary,
  DailyReviewTrigger,
  SessionSummary,
} from '@maka/core';
import { providerAuthRequiresSecret, type LlmConnection } from '@maka/core/llm-connections';
import { buildProviderOptions, getAIModel } from '@maka/runtime';
import type { createConnectionStore, createTelemetryRepo } from '@maka/storage';
import type { createDailyReviewArchiveStore } from './daily-review-archive-store.js';

const DAILY_REVIEW_ARCHIVE_LIMIT = 180;

type ConnectionStore = ReturnType<typeof createConnectionStore>;
type DailyReviewArchiveStore = ReturnType<typeof createDailyReviewArchiveStore>;
type TelemetryRepo = ReturnType<typeof createTelemetryRepo>;

export interface DailyReviewMainService {
  buildSummaryForRange(offsetDays: number, daySpan: number): Promise<DailyReviewSummary>;
  run(input: {
    mode: DailyReviewMode;
    day?: number;
    trigger: DailyReviewTrigger;
    modelKeyOverride?: string;
  }): Promise<{ archiveId: string }>;
  startScheduler(): void;
  stopScheduler(): void;
}

interface DailyReviewMainServiceDeps {
  archiveStore: DailyReviewArchiveStore;
  connectionStore: ConnectionStore;
  telemetryRepo: TelemetryRepo;
  ensureUsageReady(): Promise<void>;
  listSessions(): Promise<readonly SessionSummary[]>;
  resolveConnectionSecret(slug: string): Promise<string | null>;
  buildSubscriptionModelFetch(
    connection: LlmConnection,
    sessionId: string,
    modelId: string,
  ): typeof fetch | undefined;
}

export function createDailyReviewMainService(deps: DailyReviewMainServiceDeps): DailyReviewMainService {
  let schedulerTimer: NodeJS.Timeout | null = null;
  let schedulerLastMinuteKey: string | null = null;

  async function buildSummaryForRange(offsetDays: number, daySpan: number): Promise<DailyReviewSummary> {
    await deps.ensureUsageReady();
    const offset = Number.isFinite(offsetDays) ? Math.trunc(offsetDays) : 0;
    const rawSpan = Number.isFinite(daySpan) ? Math.trunc(daySpan) : 1;
    const span = Math.max(1, Math.min(30, rawSpan));
    const endDay =
      offset === 0
        ? localDayBoundsForInstant(Date.now())
        : localDayBoundsAt(Date.now(), offset);
    const startDay =
      span === 1
        ? endDay
        : localDayBoundsAt(Date.now(), offset - (span - 1));
    const range = { fromMs: startDay.fromMs, toMs: endDay.toMs };
    const usageQuery = dailyUsageQuery(range);
    const [usageSummary, toolBuckets, modelBuckets, sessions] = await Promise.all([
      Promise.resolve(deps.telemetryRepo.summary(usageQuery)),
      Promise.resolve(deps.telemetryRepo.buckets(usageQuery, 'tool')),
      Promise.resolve(deps.telemetryRepo.buckets(usageQuery, 'model')),
      Promise.resolve(deps.listSessions()),
    ]);
    return buildDailyReviewSummary({
      day: range,
      usageSummary,
      sessions: pickDailyReviewSessions(collapseSessionRevisions(sessions), range, DAILY_REVIEW_LIST_LIMIT),
      topTools: pickDailyReviewTopEntries(toolBuckets, DAILY_REVIEW_LIST_LIMIT),
      topModels: pickDailyReviewTopEntries(modelBuckets, DAILY_REVIEW_LIST_LIMIT),
    });
  }

  async function run(input: {
    mode: DailyReviewMode;
    day?: number;
    trigger: DailyReviewTrigger;
    modelKeyOverride?: string;
  }): Promise<{ archiveId: string }> {
    const config = await deps.archiveStore.getConfig();
    const mode = input.mode === 'deep' ? 'deep' : 'daily';
    const modelKeyOverride = input.modelKeyOverride?.trim();
    const effectiveModelKey = modelKeyOverride ? modelKeyOverride : config.modelKey;
    const summary = await buildSummaryForRange(input.day ?? 0, mode === 'deep' ? 7 : 1);
    const archiveId = dailyReviewArchiveId(summary.day, mode);
    const baseArchive: Omit<DailyReviewArchive, 'status' | 'sections' | 'errorMessage'> = {
      id: archiveId,
      day: summary.day,
      mode,
      generatedAt: Date.now(),
      trigger: input.trigger,
      modelKey: effectiveModelKey,
      totals: summary.totals,
    };

    if (summary.totals.sessionCount + summary.totals.requestCount === 0) {
      await deps.archiveStore.putArchive({
        ...baseArchive,
        status: 'no_data',
        sections: buildRuleBasedDailyReviewSections(summary, config, mode),
        errorMessage: '没有可用于生成回顾的本地活动数据。',
      });
      await deps.archiveStore.prune(DAILY_REVIEW_ARCHIVE_LIMIT);
      return { archiveId };
    }

    try {
      const modelContext = await resolveModelContext(effectiveModelKey);
      if (!modelContext) {
        await deps.archiveStore.putArchive({
          ...baseArchive,
          status: 'no_model',
          sections: buildRuleBasedDailyReviewSections(summary, config, mode),
          errorMessage: '未配置可用的分析模型。',
        });
        await deps.archiveStore.prune(DAILY_REVIEW_ARCHIVE_LIMIT);
        return { archiveId };
      }

      const sections = await generateSections({
        summary,
        config,
        mode,
        connection: modelContext.connection,
        apiKey: modelContext.apiKey,
        modelId: modelContext.modelId,
      });
      await deps.archiveStore.putArchive({
        ...baseArchive,
        modelKey: `${modelContext.connection.slug}::${modelContext.modelId}`,
        status: 'ok',
        sections,
      });
    } catch (error) {
      await deps.archiveStore.putArchive({
        ...baseArchive,
        status: 'failed',
        sections: buildRuleBasedDailyReviewSections(summary, config, mode),
        errorMessage: generalizedErrorMessageChinese(error, '每日回顾生成失败'),
      });
    }
    await deps.archiveStore.prune(DAILY_REVIEW_ARCHIVE_LIMIT);
    return { archiveId };
  }

  async function resolveModelContext(modelKey: string): Promise<{
    connection: LlmConnection;
    apiKey: string | null;
    modelId: string;
  } | null> {
    const parsed = parseModelKey(modelKey);
    const slug = parsed?.slug ?? await deps.connectionStore.getDefault();
    if (!slug) return null;
    const connection = await deps.connectionStore.get(slug);
    if (!connection || !connection.enabled) return null;
    const modelId = parsed?.modelId || connection.defaultModel;
    if (!modelId) return null;
    const apiKey = await deps.resolveConnectionSecret(connection.slug);
    if (providerAuthRequiresSecret(connection.providerType) && !apiKey) return null;
    return { connection, apiKey, modelId };
  }

  async function generateSections(input: {
    summary: DailyReviewSummary;
    config: DailyReviewConfig;
    mode: DailyReviewMode;
    connection: LlmConnection;
    apiKey: string | null;
    modelId: string;
  }): Promise<DailyReviewArchiveSectionContent> {
    const ai = await import('ai') as unknown as {
      generateText(opts: Record<string, unknown>): Promise<{ text: string }>;
    };
    const modelFetch = deps.buildSubscriptionModelFetch(input.connection, 'daily-review', input.modelId);
    const result = await ai.generateText({
      model: getAIModel({
        connection: input.connection,
        apiKey: input.apiKey ?? '',
        modelId: input.modelId,
        fetch: modelFetch,
      }),
      instructions: dailyReviewSystemPrompt(input.config),
      prompt: dailyReviewUserPrompt(input.summary, input.config, input.mode),
      providerOptions: buildProviderOptions(input.connection, input.modelId),
    });
    return parseDailyReviewSections(result.text, input.config);
  }

  function startScheduler(): void {
    if (schedulerTimer) clearInterval(schedulerTimer);
    schedulerTimer = setInterval(() => {
      void tickScheduler().catch((error) => {
        console.error('[daily-review] scheduler tick failed', error);
      });
    }, 60 * 1000);
    void tickScheduler().catch((error) => {
      console.error('[daily-review] scheduler startup tick failed', error);
    });
  }

  function stopScheduler(): void {
    if (schedulerTimer) clearInterval(schedulerTimer);
    schedulerTimer = null;
  }

  async function tickScheduler(): Promise<void> {
    const now = new Date();
    const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    if (schedulerLastMinuteKey === minuteKey) return;
    schedulerLastMinuteKey = minuteKey;

    const config = await deps.archiveStore.getConfig();
    if (!config.enabled) return;
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    if (`${hh}:${mm}` !== config.executeTime) return;

    await runIfMissing('daily');
    if (config.deepEnabled) await runIfMissing('deep');
  }

  async function runIfMissing(mode: DailyReviewMode): Promise<void> {
    const summary = await buildSummaryForRange(0, mode === 'deep' ? 7 : 1);
    const id = dailyReviewArchiveId(summary.day, mode);
    if (await deps.archiveStore.getArchive(id)) return;
    await run({ mode, trigger: 'cron' });
  }

  return {
    buildSummaryForRange,
    run,
    startScheduler,
    stopScheduler,
  };
}

function parseModelKey(modelKey: string): { slug: string; modelId: string } | null {
  const trimmed = modelKey.trim();
  if (!trimmed) return null;
  const separator = trimmed.indexOf('::');
  if (separator <= 0 || separator >= trimmed.length - 2) return null;
  return {
    slug: trimmed.slice(0, separator),
    modelId: trimmed.slice(separator + 2),
  };
}

function dailyReviewSystemPrompt(config: DailyReviewConfig): string {
  const enabled = Object.entries(config.sections)
    .filter(([, value]) => value)
    .map(([key]) => key)
    .join(', ');
  return [
    '你是 Maka 的每日回顾分析器。只基于输入的本地统计和会话预览生成回顾，不编造未出现的事实。',
    '输出 JSON，不要 Markdown fence。JSON 顶层字段只允许 summary、gaps、usage、code，值为中文字符串。',
    `启用栏目：${enabled || 'summary'}。未启用栏目可以省略。`,
  ].join('\n');
}

function dailyReviewUserPrompt(
  summary: DailyReviewSummary,
  config: DailyReviewConfig,
  mode: DailyReviewMode,
): string {
  return JSON.stringify({
    mode,
    includeClaudeCode: config.includeClaudeCode,
    day: summary.day,
    totals: summary.totals,
    sessions: summary.sessions.map((session) => ({
      name: session.name,
      lastMessageAt: session.lastMessageAt,
      preview: session.lastMessagePreview ?? '',
    })),
    topModels: summary.topModels,
    topTools: summary.topTools,
    instruction: mode === 'deep'
      ? '生成更深入的多日工作复盘：趋势、遗漏、风险、下一步。'
      : '生成当天工作回顾：发生了什么、遗漏什么、用量洞察、代码建议。',
  });
}

function parseDailyReviewSections(text: string, config: DailyReviewConfig): DailyReviewArchiveSectionContent {
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return {
      ...(config.sections.summary && typeof parsed.summary === 'string' ? { summary: parsed.summary.trim() } : {}),
      ...(config.sections.gaps && typeof parsed.gaps === 'string' ? { gaps: parsed.gaps.trim() } : {}),
      ...(config.sections.usage && typeof parsed.usage === 'string' ? { usage: parsed.usage.trim() } : {}),
      ...(config.sections.code && typeof parsed.code === 'string' ? { code: parsed.code.trim() } : {}),
    };
  } catch {
    return { summary: trimmed };
  }
}

function buildRuleBasedDailyReviewSections(
  summary: DailyReviewSummary,
  config: DailyReviewConfig,
  mode: DailyReviewMode,
): DailyReviewArchiveSectionContent {
  const sections: {
    summary?: string;
    gaps?: string;
    usage?: string;
    code?: string;
  } = {};
  if (config.sections.summary) {
    sections.summary = `${mode === 'deep' ? '深度分析' : '每日回顾'}覆盖 ${summary.totals.sessionCount} 个对话、${summary.totals.requestCount} 次请求、${summary.totals.totalTokens} tokens。`;
  }
  if (config.sections.gaps) {
    sections.gaps = summary.totals.errorCount > 0
      ? `发现 ${summary.totals.errorCount} 次错误请求，建议回看失败上下文。`
      : '未从本地统计中发现明确失败请求。';
  }
  if (config.sections.usage) {
    const topModel = summary.topModels[0];
    sections.usage = topModel
      ? `使用最多的模型是 ${topModel.label}，共 ${topModel.requests} 次请求。`
      : '暂无模型使用统计。';
  }
  if (config.sections.code) {
    const topTool = summary.topTools[0];
    sections.code = topTool
      ? `高频工具：${topTool.label}（${topTool.requests} 次）。建议优先复盘相关改动产物。`
      : '暂无工具调用统计可形成代码建议。';
  }
  return sections;
}
