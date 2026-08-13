import type { SessionHeader, StoredMessage } from '@maka/core/session';
import { header } from './seed-helpers.js';

// Settings → 使用统计 fixture. `usageStats` aggregates `token_usage` + tool
// messages across ALL sessions in the workspace, so the settings-usage capture
// only shows real tables if the seed contains enough varied traffic. These
// sessions are gated to the `settings-usage` scenario so no other capture is
// disturbed; every value is a literal keyed off the fixed `now`, so the tables
// render deterministically.
//
// The shape below intentionally spreads across:
//   - 3 providers (zai-live / relay-fallback / needs-reauth) → 供应商统计
//   - 5 models (glm / claude / gpt families) → 模型统计
//   - 6 tools with 2 failures → 工具统计 (exercises the error column)
//   - a dozen request-log rows mixing model + tool + success/error → 请求日志

interface UsageTurnSpec {
  turnId: string;
  minutesAgo: number;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheMissInput?: number;
    cacheCreation?: number;
    reasoning?: number;
    costUsd: number;
  };
  tools: Array<{
    id: string;
    toolName: string;
    displayName: string;
    durationMs: number;
    isError?: boolean;
  }>;
}

function usageTurnMessages(now: number, spec: UsageTurnSpec): StoredMessage[] {
  const turnTs = now - spec.minutesAgo * 60_000;
  const messages: StoredMessage[] = [
    {
      type: 'user',
      id: `${spec.turnId}-user`,
      turnId: spec.turnId,
      ts: turnTs - 30_000,
      text: '继续这轮工作，并汇总一次用量。',
    },
  ];
  spec.tools.forEach((tool, index) => {
    const callTs = turnTs - 24_000 + index * 3_000;
    messages.push({
      type: 'tool_call',
      id: tool.id,
      turnId: spec.turnId,
      ts: callTs,
      toolName: tool.toolName,
      displayName: tool.displayName,
      args: {},
    });
    messages.push({
      type: 'tool_result',
      id: `${tool.id}-result`,
      turnId: spec.turnId,
      ts: callTs + tool.durationMs,
      toolUseId: tool.id,
      isError: tool.isError ?? false,
      durationMs: tool.durationMs,
      content: { kind: 'text', text: tool.isError ? '调用失败（fixture）' : '调用完成（fixture）' },
    });
  });
  messages.push({
    type: 'assistant',
    id: `${spec.turnId}-assistant`,
    turnId: spec.turnId,
    ts: turnTs,
    text: '这一轮的模型请求与工具调用已完成，用量已并入统计。',
    modelId: spec.model,
  });
  messages.push({
    type: 'token_usage',
    id: `${spec.turnId}-usage`,
    turnId: spec.turnId,
    ts: turnTs + 100,
    input: spec.usage.input,
    output: spec.usage.output,
    ...(spec.usage.cacheRead !== undefined ? { cacheRead: spec.usage.cacheRead } : {}),
    ...(spec.usage.cacheMissInput !== undefined ? { cacheMissInput: spec.usage.cacheMissInput } : {}),
    ...(spec.usage.cacheCreation !== undefined ? { cacheCreation: spec.usage.cacheCreation } : {}),
    ...(spec.usage.reasoning !== undefined ? { reasoning: spec.usage.reasoning } : {}),
    costUsd: spec.usage.costUsd,
  });
  return messages;
}

function usageSession(
  now: number,
  input: { id: string; name: string; connection: string; model: string; minutesAgo: number },
): SessionHeader {
  return header({
    id: input.id,
    name: input.name,
    connection: input.connection,
    model: input.model,
    now,
    lastMessageAt: now - input.minutesAgo * 60_000,
  });
}

export function usageStatsSessions(
  now: number,
): Array<{ header: SessionHeader; messages: StoredMessage[] }> {
  return [
    {
      header: usageSession(now, {
        id: 'e2e-fixture-usage-glm',
        name: '用量样本 · GLM 工作区',
        connection: 'zai-live',
        model: 'glm-5.1',
        minutesAgo: 40,
      }),
      messages: [
        ...usageTurnMessages(now, {
          turnId: 'usage-glm-1',
          minutesAgo: 45,
          model: 'glm-5.1',
          usage: { input: 4820, output: 1240, cacheRead: 3200, cacheMissInput: 1620, cacheCreation: 640, reasoning: 210, costUsd: 0.0186 },
          tools: [
            { id: 'usage-glm-1-bash', toolName: 'Bash', displayName: '运行测试', durationMs: 8_240 },
            { id: 'usage-glm-1-read', toolName: 'Read', displayName: '读取源码', durationMs: 1_120 },
            { id: 'usage-glm-1-grep', toolName: 'Grep', displayName: '检索用法', durationMs: 640 },
          ],
        }),
        ...usageTurnMessages(now, {
          turnId: 'usage-glm-2',
          minutesAgo: 38,
          model: 'glm-5.1-air',
          usage: { input: 2110, output: 560, cacheMissInput: 2110, costUsd: 0.0071 },
          tools: [
            { id: 'usage-glm-2-edit', toolName: 'Edit', displayName: '修改文件', durationMs: 980 },
            { id: 'usage-glm-2-write', toolName: 'Write', displayName: '写入文件', durationMs: 1_460, isError: true },
          ],
        }),
      ],
    },
    {
      header: usageSession(now, {
        id: 'e2e-fixture-usage-claude',
        name: '用量样本 · Claude 中继',
        connection: 'relay-fallback',
        model: 'claude-sonnet-4.5',
        minutesAgo: 28,
      }),
      messages: [
        ...usageTurnMessages(now, {
          turnId: 'usage-claude-1',
          minutesAgo: 30,
          model: 'claude-sonnet-4.5',
          usage: { input: 6400, output: 2050, cacheRead: 5100, cacheCreation: 1300, reasoning: 880, costUsd: 0.0642 },
          tools: [
            { id: 'usage-claude-1-search', toolName: 'WebSearch', displayName: '联网检索', durationMs: 3_050 },
            { id: 'usage-claude-1-read', toolName: 'Read', displayName: '读取文档', durationMs: 900 },
          ],
        }),
        ...usageTurnMessages(now, {
          turnId: 'usage-claude-2',
          minutesAgo: 24,
          model: 'claude-haiku-4.5',
          usage: { input: 1500, output: 300, costUsd: 0.0021 },
          tools: [
            { id: 'usage-claude-2-bash', toolName: 'Bash', displayName: '构建 renderer', durationMs: 5_200 },
          ],
        }),
      ],
    },
    {
      header: usageSession(now, {
        id: 'e2e-fixture-usage-gpt',
        name: '用量样本 · GPT 备用',
        connection: 'needs-reauth',
        model: 'gpt-5.1-mini',
        minutesAgo: 16,
      }),
      messages: [
        ...usageTurnMessages(now, {
          turnId: 'usage-gpt-1',
          minutesAgo: 18,
          model: 'gpt-5.1-mini',
          usage: { input: 3300, output: 900, cacheRead: 1200, costUsd: 0.0125 },
          tools: [
            { id: 'usage-gpt-1-bash', toolName: 'Bash', displayName: '生成截图', durationMs: 6_400 },
            { id: 'usage-gpt-1-grep', toolName: 'Grep', displayName: '扫描目录', durationMs: 720, isError: true },
          ],
        }),
      ],
    },
  ];
}
