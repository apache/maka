import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  SandboxBoundaryRequestEvent,
  SessionHeader,
  StoredMessage,
  E2eFixtureState,
} from '@maka/core';
import {
  ERROR_SESSION_ID,
  header,
  PERMISSION_SESSION_ID,
  PROCESSING_SESSION_ID,
  STREAMING_SESSION_ID,
  TURN_SESSION_ID,
  E2E_FIXTURE_NOW,
} from './seed-helpers.js';

// PR-STREAM-TURN-CENTER: realistic multi-block markdown (heading + paragraph +
// list) for the `streaming-answer` scenario, so the captured streaming bubble
// exercises the same prose layout a real answer does and its left edge is
// unambiguous to compare against the committed turn above it.
const STREAMING_ANSWER_MARKDOWN = [
  '## Maka Desktop 项目概况',
  '',
  '这里是当前项目的快速概览：',
  '',
  '- 框架：Electron + React 19 + Vite 7',
  '- 语言：TypeScript',
  '- 构建：tsc（main / preload）+ Vite（renderer）',
  '',
  '正在整理目录结构，稍等……',
].join('\n');

export async function writeTaskLedgerFixture(workspaceRoot: string, now: number): Promise<void> {
  const tasks = [
    {
      id: 'task-root-implementation', key: 'T1', subject: '完成会话任务台账升级', status: 'in_progress',
      createdAt: now - 50 * 60_000, updatedAt: now - 2 * 60_000,
      owner: { actor: 'main_agent', runId: 'run-task-parent', turnId: 'turn-fixture-2' },
    },
    {
      id: 'task-child-storage', key: 'T1.1', parentId: 'task-root-implementation',
      subject: '验证旧 JSONL 迁移与并发短 key 分配', status: 'completed',
      createdAt: now - 45 * 60_000, updatedAt: now - 8 * 60_000, endedAt: now - 8 * 60_000,
      completionEvidence: 'Core 与 Storage 定向测试全部通过。',
    },
    {
      id: 'task-child-ui', key: 'T1.2', parentId: 'task-root-implementation',
      subject: '检查窄窗口下的任务树布局', status: 'blocked',
      createdAt: now - 40 * 60_000, updatedAt: now - 3 * 60_000,
      blockedReason: '等待视觉回归截图确认 990px 视口没有文字重叠。',
      owner: { actor: 'child_agent', agentId: 'local-read', runId: 'run-task-child', turnId: 'turn-task-child' },
    },
    {
      id: 'task-grandchild-copy', key: 'T1.2.1', parentId: 'task-child-ui',
      subject: '核对深层缩进、超长任务描述、owner 与阻塞原因在窄窗口中仍可完整换行且不遮挡后续内容',
      status: 'pending', createdAt: now - 35 * 60_000, updatedAt: now - 3 * 60_000,
    },
    {
      id: 'task-docs', key: 'T2', subject: '同步生命周期文档与边界说明', status: 'pending',
      createdAt: now - 30 * 60_000, updatedAt: now - 5 * 60_000,
    },
    {
      id: 'task-runtime', key: 'T3', subject: '验证 Goal 一次提醒门禁', status: 'completed',
      createdAt: now - 25 * 60_000, updatedAt: now - 6 * 60_000, endedAt: now - 6 * 60_000,
      completionEvidence: 'Goal gate 定向测试覆盖空任务、阻塞任务、一次提醒和上限放行。',
    },
  ];
  await writeFile(
    join(workspaceRoot, 'sessions', TURN_SESSION_ID, 'tasks.json'),
    `${JSON.stringify(tasks, null, 2)}\n`,
    'utf8',
  );
}

export function turnSession(now: number): SessionHeader {
  return header({
    id: TURN_SESSION_ID,
    name: '模型管理与工具调用示例',
    connection: 'zai-live',
    model: 'glm-5.1',
    now,
    lastMessageAt: now - 9 * 60_000,
  });
}

export function turnMessages(now: number): StoredMessage[] {
  const turnId = 'turn-fixture-1';
  return [
    { type: 'user', id: 'msg-user-1', turnId, ts: now - 10 * 60_000, text: '检查项目状态，列出需要我优先处理的风险。' },
    {
      type: 'tool_call',
      id: 'tool-status',
      turnId,
      ts: now - 9 * 60_000 - 50_000,
      toolName: 'Bash',
      displayName: '检查测试状态',
      intent: '运行测试摘要并读取失败输出',
      args: { cmd: 'npm test --workspaces --if-present', cwd: '/workspace/maka' },
    },
    {
      type: 'tool_result',
      id: 'tool-status-result',
      turnId,
      ts: now - 9 * 60_000 - 42_000,
      toolUseId: 'tool-status',
      isError: false,
      durationMs: 8_240,
      content: {
        kind: 'terminal',
        cwd: '/workspace/maka',
        cmd: 'npm test --workspaces --if-present',
        status: 'completed',
        exitCode: 0,
        output: {
          mode: 'pipes',
          stdout: 'core 41 passing\nstorage 17 passing\nruntime 70 passing\ndesktop 74 passing\n',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          redacted: false,
        },
      },
    },
    {
      type: 'tool_call',
      id: 'tool-diff',
      turnId,
      ts: now - 9 * 60_000 - 38_000,
      toolName: 'Read',
      displayName: '查看关键 diff',
      intent: '确认启用模型名单是否有测试覆盖',
      args: { path: 'apps/desktop/src/renderer/settings/provider-connection-detail.tsx' },
    },
    {
      type: 'tool_result',
      id: 'tool-diff-result',
      turnId,
      ts: now - 9 * 60_000 - 34_000,
      toolUseId: 'tool-diff',
      isError: false,
      durationMs: 1_120,
      content: {
        kind: 'file_diff',
        paths: ['apps/desktop/src/renderer/settings/provider-connection-detail.tsx'],
        diff: [
          'diff --git a/provider-connection-detail.tsx b/provider-connection-detail.tsx',
          '+function EnabledModelManager(props) {',
          '+  const enabled = new Set(props.enabledModelIds);',
          '+  return <ul aria-label="已启用模型" />;',
          '-// default-model radio table',
        ].join('\n'),
      },
    },
    {
      type: 'assistant',
      id: 'msg-assistant-1',
      turnId,
      ts: now - 9 * 60_000,
      text: '当前需要重点观察截图基线是否稳定、启用模型名单是否清晰，以及完整目录是否只在搜索时出现。这些状态会作为下一轮界面验收的基线。',
      thinking: {
        text: '这段是 fixture 用的模型推理草稿。它应默认折叠，并且不会进入默认复制答案路径。',
      },
      modelId: 'glm-5.1',
    },
    {
      type: 'token_usage',
      id: 'usage-1',
      turnId,
      ts: now - 9 * 60_000 + 100,
      input: 1250,
      output: 320,
      cacheRead: 180,
      costUsd: 0.0042,
    },
    // Streaming UI rework: a second, MULTI-STEP turn. Each step persists its own
    // assistant row (thinking + text) plus tool_calls tagged with that row's id
    // as `stepId`, so the turn timeline reconstructs the real per-step order —
    // 深度思考 → answer text → tool trow — instead of one trailing tool group.
    // Locks the capture for the new timeline (contrast the legacy stepless turn
    // above, which renders tools-before-text).
    ...multiStepTurnMessages(now),
  ];
}

// #646: a running session whose latest turn is a lone user prompt with no
// assistant reply yet — the on-disk shape of "just sent, awaiting first token".
// Paired with a waiting live projection + status `running`, the renderer derives the
// "正在处理…" model-wait indicator on the tail turn and the composer shows Stop.
export function processingSession(now: number): SessionHeader {
  return header({
    id: PROCESSING_SESSION_ID,
    name: '正在处理请求',
    connection: 'zai-live',
    model: 'glm-5.1',
    now,
    lastMessageAt: now - 2_000,
    status: 'running',
  });
}

export function processingMessages(now: number): StoredMessage[] {
  const turnId = 'turn-processing-1';
  return [
    { type: 'user', id: 'msg-processing-user', turnId, ts: now - 2_000, text: '把刚才那批改动整理成一份可交接的变更说明，并指出还需我确认的点。' },
  ];
}

function multiStepTurnMessages(now: number): StoredMessage[] {
  const turnId = 'turn-fixture-2';
  const step1 = 'msg-assistant-2a';
  const step2 = 'msg-assistant-2b';
  return [
    { type: 'user', id: 'msg-user-2', turnId, ts: now - 6 * 60_000, text: '确认 stream-fade 的环逻辑没有边界问题，然后跑一下单测。', origin: { kind: 'automation', automationId: 'auto-fixture-demo' } },
    {
      type: 'tool_call',
      id: 'tool-read-fade',
      turnId,
      ts: now - 6 * 60_000 + 4_000,
      toolName: 'Read',
      displayName: '读取 stream-fade.ts',
      intent: '读取淡入环实现，确认窗口滑动与上限',
      stepId: step1,
      args: { file_path: 'packages/ui/src/stream-fade.ts' },
    },
    {
      type: 'tool_result',
      id: 'tool-read-fade-result',
      turnId,
      ts: now - 6 * 60_000 + 4_600,
      toolUseId: 'tool-read-fade',
      isError: false,
      durationMs: 560,
      content: { kind: 'text', text: 'export function updateFadeRing(...) { /* prune + cap */ }' },
    },
    {
      type: 'assistant',
      id: step1,
      turnId,
      ts: now - 5 * 60_000,
      text: '环逻辑没问题：增长记录批次、超窗剪枝、按上限截断，收缩时整体重置。接下来跑单测确认。',
      thinking: { text: 'boundary 取最老存活批次的 start，age 用 now 减去覆盖该 offset 的批次时间，窗口滑动和上限都覆盖了，值得跑一遍测试坐实。' },
      modelId: 'glm-5.1',
    },
    {
      type: 'tool_call',
      id: 'tool-run-fade-tests',
      turnId,
      ts: now - 5 * 60_000 + 3_000,
      toolName: 'Bash',
      displayName: '运行 stream-fade 单测',
      intent: '执行 node --test 跑淡入环与 tokenizer 单测',
      stepId: step2,
      args: { cmd: 'node --test dist/main/__tests__/stream-fade.test.js', cwd: '/workspace/maka' },
    },
    {
      type: 'tool_result',
      id: 'tool-run-fade-tests-result',
      turnId,
      ts: now - 5 * 60_000 + 5_200,
      toolUseId: 'tool-run-fade-tests',
      isError: false,
      durationMs: 1_930,
      content: {
        kind: 'terminal',
        cwd: '/workspace/maka',
        cmd: 'node --test dist/main/__tests__/stream-fade.test.js',
        status: 'completed',
        exitCode: 0,
        output: {
          mode: 'pipes',
          stdout: 'tests 13\npass 13\nfail 0\n',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          redacted: false,
        },
      },
    },
    {
      type: 'assistant',
      id: step2,
      turnId,
      ts: now - 4 * 60_000,
      text: '13 个单测全绿，窗口滑动、乱序快照取龄和上限都被覆盖。边界没有问题。',
      thinking: { text: '测试覆盖窗口滑动、乱序 age 查询与上限三类，全过说明剪枝和 cap 的顺序对，可以收尾。' },
      modelId: 'glm-5.1',
    },
  ];
}

export function streamingSession(now: number): SessionHeader {
  return header({
    id: STREAMING_SESSION_ID,
    name: '后台流式任务',
    connection: 'zai-live',
    model: 'glm-5',
    now,
    hasUnread: true,
    lastMessageAt: now - 2 * 60_000,
  });
}

export function streamingMessages(now: number): StoredMessage[] {
  return [
    {
      type: 'user',
      id: 'stream-user',
      turnId: 'turn-streaming',
      ts: now - 2 * 60_000,
      text: '后台继续跑一轮诊断，完成后告诉我。',
    },
  ];
}

export function permissionSession(now: number): SessionHeader {
  return {
    ...header({
      id: PERMISSION_SESSION_ID,
      name: '危险权限确认',
      connection: 'zai-live',
      model: 'glm-5.1',
      now,
      lastMessageAt: now - 4 * 60_000,
    }),
    // A read-only session asking to write outside the workspace — the shape
    // #1611 is about. Its genesis boundary is therefore read-only, so the
    // permission label has something real to report both before the request is
    // answered and after the expansion widens the boundary.
    permissionMode: 'explore',
  };
}

export function permissionMessages(now: number): StoredMessage[] {
  return [
    {
      type: 'user',
      id: 'permission-user',
      turnId: 'turn-permission',
      ts: now - 4 * 60_000,
      text: '模拟一个需要不可恢复操作权限确认的场景，但不要真的执行。',
    },
    {
      type: 'tool_call',
      id: 'permission-tool',
      turnId: 'turn-permission',
      ts: now - 4 * 60_000 + 1_000,
      toolName: 'Bash',
      displayName: '模拟删除命令',
      intent: '清理构建产物目录',
      args: { command: 'rm -rf ./dist', cwd: '/workspace/maka' },
    },
  ];
}

export function errorSession(now: number): SessionHeader {
  return header({
    id: ERROR_SESSION_ID,
    name: '连接失败提示',
    connection: 'broken-provider',
    model: 'gpt-4o-mini',
    now,
    lastMessageAt: now - 20 * 60_000,
  });
}

export function errorMessages(now: number): StoredMessage[] {
  return [
    {
      type: 'user',
      id: 'error-user',
      turnId: 'turn-error',
      ts: now - 20 * 60_000,
      text: '这条会话用于验证 chat header 的连接失败提示。',
    },
  ];
}

export function streamingLiveTurns(): NonNullable<E2eFixtureState['liveTurnBySession']> {
  return {
    [STREAMING_SESSION_ID]: {
      turnId: 'turn-streaming',
      phase: 'streamed',
      steps: [{
        stepId: 'stream-live-step',
        text: {
          text: '正在检查日志、模型配置和最近的工具输出…',
          truncated: false,
          complete: false,
        },
        tools: [{
          toolUseId: 'stream-live-tool',
          toolName: 'Bash',
          stepId: 'stream-live-step',
          displayName: '运行中的诊断',
          intent: '模拟后台 stream 中的 tool activity',
          status: 'running',
          args: { cmd: 'npm run e2e-fixture:fixture' },
        }],
      }],
    },
  };
}

export function streamingAnswerLiveTurns(): NonNullable<E2eFixtureState['liveTurnBySession']> {
  return {
    [TURN_SESSION_ID]: {
      turnId: 'turn-fixture-2',
      phase: 'streamed',
      steps: [{
        stepId: 'msg-assistant-2c',
        text: { text: STREAMING_ANSWER_MARKDOWN, truncated: false, complete: false },
        tools: [],
      }],
    },
  };
}

export function processingLiveTurns(): NonNullable<E2eFixtureState['liveTurnBySession']> {
  return {
    [PROCESSING_SESSION_ID]: {
      turnId: 'turn-processing-1',
      phase: 'waiting',
      steps: [],
    },
  };
}

export function sandboxBoundaryState(): NonNullable<E2eFixtureState['sandboxBoundaryBySession']> {
  return {
    [PERMISSION_SESSION_ID]: sandboxBoundaryRequest(E2E_FIXTURE_NOW),
  };
}

export function sandboxBoundaryLiveTurns(): NonNullable<E2eFixtureState['liveTurnBySession']> {
  return {
    [PERMISSION_SESSION_ID]: {
      turnId: 'turn-sandbox-boundary',
      phase: 'streamed',
      steps: [{
        stepId: 'tool:permission-tool',
        tools: [{
          toolUseId: 'permission-tool',
          toolName: 'request_sandbox_boundary',
          displayName: '扩展沙箱边界',
          intent: '写入工作区外的构建产物目录',
          status: 'waiting_permission',
          args: { path: '/outside/dist', access: 'write', scope: 'subtree' },
        }],
      }],
    },
  };
}

function sandboxBoundaryRequest(now: number): SandboxBoundaryRequestEvent {
  return {
    type: 'sandbox_boundary_request',
    id: 'e2e-fixture-permission-event',
    turnId: 'turn-sandbox-boundary',
    ts: now,
    requestId: 'e2e-fixture-permission-request',
    toolUseId: 'permission-tool',
    justification: '写入工作区外的构建产物目录。',
    expansion: {
      filesystem: {
        entries: [{ path: '/outside/dist', access: 'write', scope: 'subtree' }],
      },
    },
  };
}
