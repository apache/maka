/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { AgentRunHeader } from '@maka/core/agent-run';
import {
  MODEL_CALL_ATTEMPT_SCHEMA_VERSION,
  type ModelCallAttempt,
} from '@maka/core/model-call-attempt';
import type { SessionHeader, StoredMessage } from '@maka/core/session';
import type { TelemetryIndexWriter } from '@maka/storage/usage-stores';
import { header } from './seed-helpers.js';

type PersistedToolInvocationRecord = Parameters<
  TelemetryIndexWriter['recordToolInvocation']
>[0];

// Settings → 使用统计 fixture. Session messages keep the task links realistic,
// while `usageStatsRecords` seeds the two Host-owned surfaces the page reads:
// model calls go through the CANONICAL model-call ledger (AgentRun
// `model_call_attempt_recorded` events, projected by
// `catchUpModelCallProjection`), and tool invocations stay on the legacy
// telemetry table (tools have no canonical ledger). These records are gated to
// `settings-usage` so no other capture is disturbed; every value is derived
// from the fixed fixture clock for deterministic tables.
//
// The shape below intentionally spreads across:
//   - 3 connections (zai-live / relay-fallback / needs-reauth) → 供应商统计
//   - 5 models (glm / claude / gpt families) → 模型统计
//   - 6 tools with 2 failures → 工具统计 (exercises the error column)
//   - a dozen activity rows mixing model + tool + success/error → 活动记录

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

export function usageStatsRecords(now: number): {
  modelCalls: Array<{ header: AgentRunHeader; attempt: ModelCallAttempt }>;
  tools: PersistedToolInvocationRecord[];
} {
  const sessions = usageStatsSessions(now);
  const modelCalls: Array<{ header: AgentRunHeader; attempt: ModelCallAttempt }> = [];
  const tools: PersistedToolInvocationRecord[] = [];
  for (const { header: session, messages } of sessions) {
    const modelByTurn = new Map(
      messages
        .filter((message) => message.type === 'assistant')
        .map((message) => [message.turnId, message.modelId]),
    );
    const toolResults = new Map(
      messages
        .filter((message) => message.type === 'tool_result')
        .map((message) => [message.toolUseId, message]),
    );
    for (const message of messages) {
      if (message.type === 'token_usage') {
        const inputTokens = message.input;
        const outputTokens = message.output;
        const cacheRead = message.cacheRead ?? 0;
        const cacheMiss = message.cacheMissInput ?? Math.max(0, inputTokens - cacheRead);
        const cacheWrite = message.cacheCreation ?? 0;
        const modelId = modelByTurn.get(message.turnId) ?? session.model;
        // Run/attempt ids must match SAFE_ID_PATTERN ([A-Za-z0-9_-]); no colons.
        const runId = `run-${message.id}`;
        modelCalls.push({
          header: {
            runId,
            sessionId: session.id,
            turnId: message.turnId,
            status: 'created',
            backendKind: 'fake',
            llmConnectionSlug: session.llmConnectionSlug,
            modelId,
            cwd: '/tmp/e2e-usage',
            permissionMode: 'ask',
            createdAt: message.ts - 2_000,
            updatedAt: message.ts,
          },
          attempt: {
            schemaVersion: MODEL_CALL_ATTEMPT_SCHEMA_VERSION,
            logicalCallId: message.id,
            attemptId: message.id,
            traceId: message.turnId,
            sessionId: session.id,
            runId,
            turnId: message.turnId,
            step: 0,
            attempt: 0,
            callKind: 'main',
            connectionSlug: session.llmConnectionSlug,
            providerId: session.llmConnectionSlug,
            modelId,
            startedAt: message.ts - 2_000,
            completedAt: message.ts,
            latencyMs: 2_000,
            status: 'completed',
            usageBasis: 'reported',
            inputTokens,
            outputTokens,
            cacheReadInputTokens: cacheRead,
            cacheMissInputTokens: cacheMiss,
            cacheWriteInputTokens: cacheWrite,
            reasoningTokens: message.reasoning ?? 0,
            costBasis: 'priced',
            costUsd: message.costUsd ?? 0,
          },
        });
      }
      if (message.type === 'tool_call') {
        const result = toolResults.get(message.id);
        const durationMs = result?.durationMs ?? 0;
        const ts = result?.ts ?? message.ts;
        tools.push({
          id: `tool:${message.id}`,
          sessionId: session.id,
          turnId: message.turnId,
          toolCallId: message.id,
          toolName: message.displayName ?? message.toolName,
          providerId: session.llmConnectionSlug,
          modelId: modelByTurn.get(message.turnId) ?? session.model,
          durationMs,
          status: result?.isError ? 'error' : 'success',
          bytesIn: 0,
          bytesOut: 0,
          startedAt: message.ts,
          date: new Date(ts).toISOString().slice(0, 10),
          ts,
        });
      }
    }
  }
  return { modelCalls, tools };
}
