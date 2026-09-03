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

import type { CSSProperties } from 'react';
import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { ArtifactRecord } from '@maka/core/artifacts';
import type { BrowserState } from '@maka/core/browser';
import type { GitReviewReadResult, GitReviewSnapshot } from '@maka/core/git-review';
import type { SessionSummary } from '@maka/core/session';
import type { SessionTodoItem } from '@maka/core/session-todo';
import type { SessionTrace } from '@maka/core/session-trace';
import type { ContextDiagnosticsResult } from '@maka/runtime-host/protocol';
import { ToastProvider } from '@maka/ui';
import { WorkbarServicesProvider } from '../src/renderer/features/workbar';
import { WorkbarSurface } from '../src/renderer/features/workbar/stories';
import {
  createFakeWorkbarServices,
  createSessionWorkbarPanelsState,
  createSessionWorkbarTabsState,
  openStaticSessionWorkbarTab,
  terminalSessionWorkbarTabId,
  type QuoteCompanionPanelState,
  type SessionWorkbarTab,
  type SessionWorkbarTabKind,
  type WorkbarSessionUsageSummary,
} from '../src/renderer/features/workbar/testing';

// Fidelity convention (#1433): every story below names the real app path
// that reaches it. See apps/desktop/stories/FIDELITY.md.
//
// One group for the whole workbar, because the workbar is the only host any of
// these panels has. Each tab renders its real component inside the real shell,
// so the frame is the app's rather than a retyped approximation — which is what
// FIDELITY asks for, and what a per-panel story cannot give: the earlier
// separate Artifact Pane / Session Trace / Task Ledger groups each carried a
// hand-written box, and two of them re-rendered pixels this group already owns.
//
// What this group cannot show: the seam. The workbar's surface tone only reads
// as a seam against the conversation plate it stands beside, and the plate is
// two levels up in the shell — as is the titlebar clearance the surface bleeds
// through. Both are pinned by computed-style assertions in
// e2e/session-workbar.spec.ts instead.
//
// Read these at a canvas of 990px or wider. The app's own breakpoint is on the
// viewport, and Storybook's canvas IS the viewport, so a narrower window puts
// the panel in its stacked full-width variant rather than in a column. That is
// the real rule firing, not the story misbehaving; the render smoke mounts at
// 1280, above it.

const SESSION_ID = 'session-workbar';
const STACKED_WINDOW_VIEWPORT = {
  makaStackedWindow: {
    name: 'Maka window below the 990px stack point',
    styles: { width: '900px', height: '900px' },
    type: 'desktop' as const,
  },
};
const NOW = Date.UTC(2026, 6, 31, 10, 30, 0);
const EMPTY_BROWSER_STATE: BrowserState = {
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  loading: false,
  secure: false,
  hasPage: false,
};
const LOADED_BROWSER_STATE: BrowserState = {
  ...EMPTY_BROWSER_STATE,
  url: 'https://maka.apache.org/docs/getting-started',
  title: 'Getting started — Apache Maka',
  canGoBack: true,
  secure: true,
  hasPage: true,
};
// A pathologically long address + title — the one layout edge a browser value
// can break, since the address field has to keep the URL legible at the
// column's 320px floor.
const LONG_BROWSER_URL =
  'https://maka.apache.org/docs/getting-started/configuration/advanced/runtime-host/agent-graph/scheduling/readiness-and-activation/edge-cases?highlight=very-long-query-string-that-keeps-going#a-deep-anchor-that-also-runs-long';
const LONG_BROWSER_TITLE =
  'Getting started · Configuration · Advanced · Runtime Host · Agent Graph scheduling, readiness, and activation edge cases — Apache Maka documentation';
const TOOL_PICKER_SOURCE_SESSION: SessionSummary = {
  id: SESSION_ID,
  name: '工作栏组件审查',
  isFlagged: false,
  isArchived: false,
  labels: [],
  hasUnread: false,
  status: 'active',
  lastMessageAt: NOW,
  backend: 'ai-sdk',
  llmConnectionSlug: 'anthropic-main',
  connectionLocked: false,
  model: 'claude-sonnet-4-5',
  permissionMode: 'ask',
};
const SIDE_CHAT_SESSION: SessionSummary = {
  ...TOOL_PICKER_SOURCE_SESSION,
  id: 'session-workbar-side-chat',
  name: '侧边对话',
};
const TERMINAL_REF = 'shell-run:storybook-terminal';
const SIDE_CHAT_PANEL_ID = 'storybook-side-chat';

// A terminal whose scrollback runs long — the "very many rows" state a fresh
// shell never shows.
const LONG_TERMINAL_BUFFER = [
  '$ npm run build --workspaces',
  ...Array.from(
    { length: 600 },
    (_, index) => `\x1b[2m[${String(index + 1).padStart(4, '0')}]\x1b[0m compiled module ${index + 1}/600`,
  ),
  '$ ',
].join('\r\n');

// Colours, bold, and a carriage-return progress redraw — the control sequences
// a plain "npm test" line never exercises.
const RICH_TERMINAL_BUFFER = [
  '$ npm test',
  '\x1b[1m\x1b[34mRUNS\x1b[0m packages/ui/src/toast.test.ts',
  '\x1b[32m✓\x1b[0m renders every variant \x1b[2m(12 ms)\x1b[0m',
  '\x1b[33m●\x1b[0m skipped: flaky under load',
  '\x1b[31m✗\x1b[0m confirm queue focus \x1b[2m(3 ms)\x1b[0m',
  '\x1b[31m  Expected the cancel button to hold focus\x1b[0m',
  'Progress: [\x1b[32m##########\x1b[0m----------] 50%\rProgress: [\x1b[32m####################\x1b[0m] 100%',
  '\x1b[1mTests:\x1b[0m \x1b[32m41 passed\x1b[0m, \x1b[31m1 failed\x1b[0m, \x1b[33m1 skipped\x1b[0m',
  '$ ',
].join('\r\n');

// ---- ledgers -------------------------------------------------------------

// The long item is deliberate: it is what proves a long subject still wraps
// instead of pushing the panel sideways.
const tasks: SessionTodoItem[] = [
  { content: '完成会话任务台账升级', status: 'in_progress' },
  { content: '验证 SQLite authority 与并发短 key 分配', status: 'completed' },
  { content: '检查窄窗口下的任务树布局', status: 'pending' },
  {
    content:
      '核对深层缩进、超长任务描述、owner 与阻塞原因在窄窗口中仍可完整换行且不遮挡后续内容',
    status: 'pending',
  },
  { content: '同步生命周期文档与边界说明', status: 'pending' },
  { content: '验证 Goal 一次提醒门禁', status: 'completed' },
];

const artifacts: ArtifactRecord[] = [
  {
    id: 'artifact-patch',
    sessionId: SESSION_ID,
    turnId: 'turn-review',
    createdAt: NOW,
    name: 'slice-9-conversation.diff',
    kind: 'diff',
    relativePath: `${SESSION_ID}/slice-9-conversation.diff`,
    sizeBytes: 4_812,
    mimeType: 'text/x-diff',
    source: 'tool_result',
    status: 'live',
  },
  {
    id: 'artifact-notes',
    sessionId: SESSION_ID,
    turnId: 'turn-review',
    createdAt: NOW - 60_000,
    name: 'conversation-review-notes-with-a-deliberately-long-name.md',
    kind: 'file',
    relativePath: `${SESSION_ID}/conversation-review-notes.md`,
    sizeBytes: 1_284,
    mimeType: 'text/markdown',
    source: 'tool_result',
    status: 'live',
  },
];

const artifactText: Record<string, string> = {
  'artifact-patch': [
    'diff --git a/apps/desktop/src/renderer/session-workbar.tsx',
    '-    <aside className="maka-session-workbar">',
    '+    <Card variant="transparent" padding={0} height="100%">',
  ].join('\n'),
  'artifact-notes': '# Conversation review\n\n- Long transcript\n- Narrow viewport',
};

const gitReviewFiles: GitReviewSnapshot['files'] = [
  {
    // The deep path is deliberate: it is what proves a long file path
    // ellipsizes inside the narrow panel instead of pushing the change counts
    // and chevron off the row (issue: 变更 rows clipped when the path is long).
    path: '.scratch/pyclient/gen/client/Comparator_pb2.py',
    status: 'added',
    additions: 129,
    deletions: 0,
    diff: [
      'diff --git a/.scratch/pyclient/gen/client/Comparator_pb2.py b/.scratch/pyclient/gen/client/Comparator_pb2.py',
      '--- /dev/null',
      '+++ b/.scratch/pyclient/gen/client/Comparator_pb2.py',
      '@@ -0,0 +1,2 @@',
      '+# Generated by the protocol buffer compiler. DO NOT EDIT!',
      '+from google.protobuf import descriptor as _descriptor',
    ].join('\n'),
  },
  {
    path: 'apps/desktop/src/renderer/session-review-panel.tsx',
    status: 'modified',
    additions: 28,
    deletions: 94,
    diff: [
      'diff --git a/apps/desktop/src/renderer/session-review-panel.tsx b/apps/desktop/src/renderer/session-review-panel.tsx',
      '--- a/apps/desktop/src/renderer/session-review-panel.tsx',
      '+++ b/apps/desktop/src/renderer/session-review-panel.tsx',
      '@@ -30,8 +30,6 @@',
      "-type ReviewSource = GitReviewSource | 'last-turn';",
      '+const REVIEW_FILE_PAGE_SIZE = 20;',
      '-const [messages, setMessages] = useState<StoredMessage[]>([]);',
      "+source: 'branch',",
    ].join('\n'),
  },
  {
    path: 'apps/desktop/src/renderer/locales/conversation-copy.ts',
    status: 'modified',
    additions: 17,
    deletions: 4,
    diff: [
      'diff --git a/apps/desktop/src/renderer/locales/conversation-copy.ts b/apps/desktop/src/renderer/locales/conversation-copy.ts',
      '--- a/apps/desktop/src/renderer/locales/conversation-copy.ts',
      '+++ b/apps/desktop/src/renderer/locales/conversation-copy.ts',
      '@@ -372,1 +372,1 @@',
      "-      review: '审阅',",
      "+      review: '变更',",
    ].join('\n'),
  },
  {
    path: 'apps/desktop/src/main/git-review-main.ts',
    status: 'modified',
    additions: 18,
    deletions: 0,
    diff: [
      'diff --git a/apps/desktop/src/main/git-review-main.ts b/apps/desktop/src/main/git-review-main.ts',
      '--- a/apps/desktop/src/main/git-review-main.ts',
      '+++ b/apps/desktop/src/main/git-review-main.ts',
      '@@ -56,1 +56,4 @@',
      "+const branchComparison = await runGit(repositoryRoot, ['merge-base', baseBranch, 'HEAD']);",
    ].join('\n'),
  },
];

const gitReviewSnapshot: GitReviewSnapshot = {
  source: 'branch',
  repositoryRoot: '/Users/reviewer/maka-agent',
  currentBranch: 'feat/git-authoritative-changes',
  baseBranch: 'main',
  baseBranchOptions: ['main', 'release/0.1'],
  revision: 'storybook-git-review',
  additions: gitReviewFiles.reduce((total, file) => total + file.additions, 0),
  deletions: gitReviewFiles.reduce((total, file) => total + file.deletions, 0),
  truncated: false,
  files: gitReviewFiles,
};

// A session whose branch matches its base — the panel's own empty state, not an
// error and not a spinner.
const emptyGitReviewSnapshot: GitReviewSnapshot = {
  ...gitReviewSnapshot,
  revision: 'storybook-git-review-empty',
  additions: 0,
  deletions: 0,
  truncated: false,
  files: [],
};

// Two independent truncation authorities, kept in separate stories: the
// snapshot-level `truncated` flag (the source dropped files from a huge
// changeset) and the per-file 500-line `boundedDiff` cap (one file's body is
// clipped). A single large file only trips the latter, so they are not merged.
const largeAddedFilePath = 'src/generated/catalog.ts';
const largeGitReviewFile: GitReviewSnapshot['files'][number] = {
  path: largeAddedFilePath,
  status: 'added',
  additions: 620,
  deletions: 0,
  diff: [
    `diff --git a/${largeAddedFilePath} b/${largeAddedFilePath}`,
    'new file mode 100644',
    'index 0000000..a1b2c3d',
    '--- /dev/null',
    `+++ b/${largeAddedFilePath}`,
    '@@ -0,0 +1,620 @@',
    ...Array.from({ length: 620 }, (_, index) => `+  export const ENTRY_${index} = ${index};`),
  ].join('\n'),
};
// Per-file cap only: one 620-line file, snapshot NOT truncated.
const fileLineCapGitReviewSnapshot: GitReviewSnapshot = {
  ...gitReviewSnapshot,
  revision: 'storybook-git-review-file-cap',
  additions: largeGitReviewFile.additions,
  deletions: 0,
  truncated: false,
  files: [largeGitReviewFile],
};
// Source-level truncation: a large changeset whose file list the source capped,
// so `truncated` is set and the panel shows its 变化过多 banner. Each file is
// ordinary — no single file trips the per-file cap here.
const sourceTruncatedFiles: GitReviewSnapshot['files'] = Array.from({ length: 24 }, (_, index) => {
  const path = `src/feature-${String(index).padStart(2, '0')}.ts`;
  return {
    path,
    status: 'modified',
    additions: 3,
    deletions: 1,
    diff: [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      '@@ -1,2 +1,4 @@',
      ' import { register } from "./registry";',
      `+export const FLAG_${index} = true;`,
      `-const legacy${index} = null;`,
    ].join('\n'),
  };
});
const sourceTruncatedGitReviewSnapshot: GitReviewSnapshot = {
  ...gitReviewSnapshot,
  revision: 'storybook-git-review-truncated',
  additions: sourceTruncatedFiles.reduce((total, file) => total + file.additions, 0),
  deletions: sourceTruncatedFiles.reduce((total, file) => total + file.deletions, 0),
  truncated: true,
  files: sourceTruncatedFiles,
};

// The diff shapes that never appear in a routine "a few lines changed" review:
// a binary blob, a rename with no body, a deletion, a no-newline-at-EOF marker,
// and a single pathologically long minified line. Each is just a different
// unified-diff string handed to the same DiffCodePreview.
const edgeGitReviewFiles: GitReviewSnapshot['files'] = [
  {
    path: 'assets/logo.png',
    status: 'modified',
    additions: 0,
    deletions: 0,
    diff: [
      'diff --git a/assets/logo.png b/assets/logo.png',
      'index e69de29..d95f3ad 100644',
      'Binary files a/assets/logo.png and b/assets/logo.png differ',
    ].join('\n'),
  },
  {
    path: 'src/renamed-module.ts',
    previousPath: 'src/old-module.ts',
    status: 'renamed',
    additions: 1,
    deletions: 1,
    diff: [
      'diff --git a/src/old-module.ts b/src/renamed-module.ts',
      'similarity index 92%',
      'rename from src/old-module.ts',
      'rename to src/renamed-module.ts',
      '--- a/src/old-module.ts',
      '+++ b/src/renamed-module.ts',
      '@@ -1,3 +1,3 @@',
      ' import { foo } from "./foo";',
      '-export const NAME = "old";',
      '+export const NAME = "renamed";',
      ' export default NAME;',
    ].join('\n'),
  },
  {
    path: 'src/deprecated.ts',
    status: 'deleted',
    additions: 0,
    deletions: 3,
    diff: [
      'diff --git a/src/deprecated.ts b/src/deprecated.ts',
      'deleted file mode 100644',
      'index 1a2b3c4..0000000',
      '--- a/src/deprecated.ts',
      '+++ /dev/null',
      '@@ -1,3 +0,0 @@',
      '-export function legacy() {',
      '-  return true;',
      '-}',
    ].join('\n'),
  },
  {
    path: 'config/version',
    status: 'modified',
    additions: 1,
    deletions: 1,
    diff: [
      'diff --git a/config/version b/config/version',
      '--- a/config/version',
      '+++ b/config/version',
      '@@ -1 +1 @@',
      '-1.2.3',
      '\\ No newline at end of file',
      '+1.2.4',
      '\\ No newline at end of file',
    ].join('\n'),
  },
  {
    path: 'src/minified.bundle.js',
    status: 'modified',
    additions: 1,
    deletions: 0,
    diff: [
      'diff --git a/src/minified.bundle.js b/src/minified.bundle.js',
      '--- a/src/minified.bundle.js',
      '+++ b/src/minified.bundle.js',
      '@@ -1,1 +1,2 @@',
      ' /* build output */',
      `+const PAYLOAD="${'a'.repeat(1800)}";`,
    ].join('\n'),
  },
];
const edgeGitReviewSnapshot: GitReviewSnapshot = {
  ...gitReviewSnapshot,
  revision: 'storybook-git-review-edge',
  additions: edgeGitReviewFiles.reduce((total, file) => total + file.additions, 0),
  deletions: edgeGitReviewFiles.reduce((total, file) => total + file.deletions, 0),
  truncated: false,
  files: edgeGitReviewFiles,
};

const populatedTrace: SessionTrace = {
  schemaVersion: 1,
  sessionId: SESSION_ID,
  turns: [
    {
      turnId: 'turn-1',
      runId: 'run-1',
      startedAt: NOW,
      endedAt: NOW + 8_400,
      durationMs: 8_400,
      steps: [
        {
          kind: 'model_call',
          id: 'call-1',
          turnId: 'turn-1',
          runId: 'run-1',
          startedAt: NOW,
          endedAt: NOW + 3_100,
          durationMs: 3_100,
          callKind: 'main',
          providerId: 'zai',
          modelId: 'glm-5.1',
          step: 0,
          status: 'completed',
          costUsd: 0.0182,
          attempts: [
            {
              attemptId: 'attempt-1a',
              attempt: 0,
              status: 'failed',
              startedAt: NOW,
              completedAt: NOW + 900,
              latencyMs: 900,
              errorClass: 'overloaded',
              costBasis: 'unpriced',
              usageBasis: 'missing',
            },
            {
              attemptId: 'attempt-1b',
              attempt: 1,
              status: 'completed',
              startedAt: NOW + 1_000,
              completedAt: NOW + 3_100,
              latencyMs: 2_100,
              inputTokens: 62_400,
              outputTokens: 480,
              cacheReadInputTokens: 58_900,
              reasoningTokens: 120,
              contextWindow: 200_000,
              costUsd: 0.0182,
              costBasis: 'priced',
              usageBasis: 'reported',
            },
          ],
        },
        {
          kind: 'tool',
          id: 'tool-1',
          turnId: 'turn-1',
          runId: 'run-1',
          startedAt: NOW + 3_200,
          endedAt: NOW + 3_760,
          durationMs: 560,
          toolName: 'read',
          status: 'completed',
        },
        {
          kind: 'compaction',
          id: 'compaction-1',
          turnId: 'turn-1',
          runId: 'run-1',
          startedAt: NOW + 3_800,
          checkpointId: 'checkpoint-9',
        },
      ],
    },
    {
      turnId: 'turn-2',
      runId: 'run-2',
      startedAt: NOW + 20_000,
      endedAt: NOW + 24_500,
      durationMs: 4_500,
      steps: [
        {
          kind: 'tool',
          id: 'tool-2',
          turnId: 'turn-2',
          runId: 'run-2',
          startedAt: NOW + 20_100,
          endedAt: NOW + 21_900,
          durationMs: 1_800,
          toolName: 'bash',
          status: 'failed',
          recovered: { disposition: 'parked', reasonCode: 'sandbox_denied' },
        },
        {
          kind: 'error',
          id: 'error-1',
          turnId: 'turn-2',
          runId: 'run-2',
          startedAt: NOW + 22_000,
          message: 'sandbox denied the write',
        },
      ],
      failure: { code: 'tool_failed', message: 'sandbox denied the write' },
    },
    {
      turnId: 'turn-3',
      runId: 'run-3',
      startedAt: NOW + 40_000,
      endedAt: NOW + 43_600,
      durationMs: 3_600,
      steps: [
        {
          kind: 'model_call',
          id: 'call-3',
          turnId: 'turn-3',
          runId: 'run-3',
          startedAt: NOW + 40_000,
          endedAt: NOW + 42_900,
          durationMs: 2_900,
          callKind: 'main',
          providerId: 'zai',
          modelId: 'glm-5.1',
          step: 0,
          status: 'completed',
          costUsd: 0.0061,
          attempts: [
            {
              attemptId: 'attempt-3a',
              attempt: 0,
              status: 'completed',
              startedAt: NOW + 40_000,
              completedAt: NOW + 42_900,
              latencyMs: 2_900,
              timeToFirstTokenMs: 640,
              inputTokens: 18_900,
              outputTokens: 260,
              cacheReadInputTokens: 15_200,
              contextWindow: 200_000,
              costUsd: 0.0061,
              costBasis: 'priced',
              usageBasis: 'reported',
            },
          ],
        },
      ],
    },
  ],
  coverage: {
    modelCalls: 'partial',
    turnsMissingModelCalls: [{ runId: 'run-2', turnId: 'turn-2' }],
    unreadableRecords: 1,
    oversizedRuns: 0,
    turnsWithFewerModelCallsThanSteps: [],
  },
};

const narrowTrace: SessionTrace = {
  ...populatedTrace,
  turns: populatedTrace.turns.map((turn) =>
    turn.turnId === 'turn-2'
      ? {
          ...turn,
          failure: { code: 'turn_aborted', message: 'turn was aborted' },
        }
      : turn,
  ),
};

const populatedContext: ContextDiagnosticsResult = {
  status: 'available',
  providerId: 'zai',
  modelId: 'glm-5.1',
  completedAt: NOW + 42_900,
  inputTokens: 18_900,
  // Providers that cache always count the hits, and most real sessions carry
  // one — the bar splits the prompt only when the snapshot reports it.
  cacheReadInputTokens: 15_200,
  contextWindow: 200_000,
  composition: {
    segments: [
      { kind: 'system_instructions', bytes: 12_000 },
      { kind: 'tool_definitions', bytes: 42_000 },
      { kind: 'messages', bytes: 21_800 },
      { kind: 'other', bytes: 400 },
    ],
    tools: [
      { name: 'Bash', bytes: 9_400 },
      { name: 'Read', bytes: 7_100 },
      { name: 'Edit', bytes: 6_300 },
      { name: 'Grep', bytes: 5_200 },
      { name: 'mcp__Claude_Browser__computer', bytes: 4_800 },
      { name: 'WebFetch', bytes: 3_900 },
      { name: 'Write', bytes: 3_100 },
      { name: 'Glob', bytes: 2_200 },
    ],
  },
};

/** A ledger written before tool schemas carried a name: bytes, no names. */
/**
 * The same session with its latest prompt resized. The bar reads the snapshot
 * now, so "near the limit" is a property of the snapshot rather than of a
 * trace attempt (#2323).
 */
const nearLimitContext: ContextDiagnosticsResult = {
  ...populatedContext,
  ...(populatedContext.status === 'available'
    ? { inputTokens: 186_400, cacheReadInputTokens: 151_800 }
    : {}),
};

const unnamedToolsContext: ContextDiagnosticsResult = {
  ...populatedContext,
  composition: {
    segments: populatedContext.status === 'available' ? populatedContext.composition!.segments : [],
    unlabelledToolBytes: 42_000,
  },
};

/**
 * The durable metering record named this request; the best-effort capture that
 * would have explained it never landed. A real state, and the one the panel
 * must state rather than render as an empty prompt.
 */
const unrecordedContext: ContextDiagnosticsResult = {
  status: 'available',
  providerId: 'zai',
  modelId: 'glm-5.1',
  completedAt: NOW + 42_900,
  inputTokens: 18_900,
  contextWindow: 200_000,
};

const emptyTrace: SessionTrace = {
  schemaVersion: 1,
  sessionId: SESSION_ID,
  turns: [],
  coverage: {
    modelCalls: 'none',
    turnsMissingModelCalls: [],
    unreadableRecords: 0,
    oversizedRuns: 0,
    turnsWithFewerModelCallsThanSteps: [],
  },
};

const olderTrace: SessionTrace = {
  ...emptyTrace,
  turns: [
    {
      turnId: 'turn-older',
      runId: 'run-older',
      startedAt: NOW - 60_000,
      endedAt: NOW - 60_000,
      durationMs: 0,
      steps: [],
    },
  ],
};

const emptyUsageSummary: WorkbarSessionUsageSummary = {
  range: { from: NOW, to: NOW },
  totalRequests: 0,
  totalCostUsd: 0,
  totalDurationMs: 0,
  totalTokens: {
    input: 0,
    output: 0,
    cacheMiss: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 0,
  },
  cacheHitRequests: 0,
  cacheCreateRequests: 0,
  errorRequests: 0,
  provenance: {
    coverage: {
      attempts: 0,
      pricedAttempts: 0,
      unpricedAttempts: 0,
      usageReportedAttempts: 0,
      usagePartialAttempts: 0,
      usageMissingAttempts: 0,
    },
    legacyRecords: 0,
    unreadableRecords: 0,
    pendingRepairs: 0,
  },
};

const populatedUsageSummary: WorkbarSessionUsageSummary = {
  range: { from: NOW, to: NOW + 43_600 },
  totalRequests: 3,
  totalCostUsd: 0.0243,
  totalDurationMs: 38_400,
  totalTokens: {
    input: 81_300,
    output: 740,
    cacheMiss: 7_200,
    cacheRead: 74_100,
    cacheWrite: 0,
    reasoning: 120,
    total: 82_040,
  },
  cacheHitRequests: 2,
  cacheCreateRequests: 0,
  errorRequests: 1,
  provenance: {
    coverage: {
      attempts: 3,
      pricedAttempts: 2,
      unpricedAttempts: 1,
      usageReportedAttempts: 2,
      usagePartialAttempts: 0,
      usageMissingAttempts: 1,
    },
    legacyRecords: 0,
    unreadableRecords: 1,
    pendingRepairs: 0,
  },
};

// ---- services ------------------------------------------------------------

const noop = () => undefined;
const unsubscribe = () => () => undefined;

/**
 * The four service groups the workbar reads at once. Needing all of them together is
 * why the shell had no story before; each option below is the one fact a story
 * varies, and everything else stays on the populated default.
 */
function bridge(options: {
  tasks?: SessionTodoItem[];
  tasksFail?: boolean;
  trace?: SessionTrace;
  traceNextCursor?: string;
  traceFail?: boolean;
  /** The context snapshot the composition block reads (#2323). */
  context?: ContextDiagnosticsResult;
  browserState?: BrowserState;
  /** Make `browser.navigate` reject, so a valid address surfaces the navigation-failed toast. */
  browserNavigateFails?: boolean;
  /** The git-review read result the 变更 panel receives (empty / source error / truncated / edge diffs). */
  review?: GitReviewReadResult;
  /** Make `review.read` reject, so the panel shows its load-error banner. */
  reviewFail?: boolean;
  /** Make `terminal.attach` resolve to null, so the panel shows its load-failed Banner. */
  terminalAttach?: 'missing';
  /** The scrollback buffer the attached terminal hydrates with. */
  terminalBuffer?: string;
  /** Make `terminal.write` reject, so typing into the terminal shows the write-failed Banner. */
  terminalWriteFails?: boolean;
} = {}): Decorator {
  const browserState = options.browserState ?? EMPTY_BROWSER_STATE;
  const services = createFakeWorkbarServices({
    todo: {
      read: async () => {
        if (options.tasksFail) throw new Error('读取任务失败');
        return options.tasks ?? tasks;
      },
      subscribeChanges: unsubscribe,
    },
    artifacts: {
      list: async () => artifacts,
      readText: async (_sessionId: string, id: string) => ({ ok: true, text: artifactText[id] ?? '' }),
      readBinary: async () => ({ ok: false, reason: 'unsupported_mime' }),
      delete: async () => undefined,
      subscribeChanges: unsubscribe,
      openPath: async () => ({ ok: true, opened: 'artifact-patch' }),
      saveAs: async () => ({ ok: true, saved: 'slice-9-conversation.diff' }),
    },
    inspector: {
      trace: async (_sessionId, cursor) =>
        options.traceFail
          ? {
              ok: false,
              error: { code: 'TRACE_READ_FAILED', message: '追踪读取失败：无法读取运行记录' },
            }
          : {
              ok: true,
              data: cursor
                ? { trace: olderTrace, nextCursor: null }
                : {
                    trace: options.trace ?? emptyTrace,
                    nextCursor: options.traceNextCursor ?? null,
                  },
            },
      summary: async () => ({
        ok: true,
        data:
          options.trace && options.trace.turns.length > 0
            ? populatedUsageSummary
            : emptyUsageSummary,
      }),
      subscribeUsageChanges: unsubscribe,
      context: async () => ({
        ok: true,
        data: options.context ?? { status: 'unavailable', reason: 'no_completed_request' },
      }),
      subscribeSessionEvents: unsubscribe,
    },
    review: {
      read: async () => {
        if (options.reviewFail) throw new Error('读取变更失败：无法运行 git diff');
        return options.review ?? { ok: true, snapshot: gitReviewSnapshot };
      },
      subscribeSessionEvents: unsubscribe,
    },
    terminal: {
      start: async () => {
        throw new Error('Terminal stories mount an existing resource');
      },
      stop: async () => null,
      attach: async () => {
        if (options.terminalAttach === 'missing') return null;
        return {
          sessionId: SESSION_ID,
          ref: TERMINAL_REF,
          sequence: 1,
          buffer: options.terminalBuffer ?? '$ npm test\r\n✓ workbar controller\r\n',
          size: { cols: 80, rows: 24 },
        };
      },
      detach: async () => undefined,
      write: async () => {
        if (options.terminalWriteFails) throw new Error('write failed');
        return null;
      },
      subscribePtyData: unsubscribe,
      subscribeResync: unsubscribe,
    },
    browser: {
      setActiveSession: noop,
      setViewport: noop,
      navigate: async () => {
        if (options.browserNavigateFails) throw new Error('navigation failed');
      },
      back: async () => undefined,
      forward: async () => undefined,
      reload: async () => undefined,
      stop: async () => undefined,
      close: async () => undefined,
      getState: async () => browserState,
      subscribeState: unsubscribe,
      subscribeLive: unsubscribe,
    },
    sideChat: {
      listSessions: async () => [TOOL_PICKER_SOURCE_SESSION, SIDE_CHAT_SESSION],
      listTurns: async () => [
        {
          turnId: 'source-turn',
          status: 'completed',
          partialOutputRetained: false,
        },
      ],
      readSettledMessages: async () => ({ messages: [], settled: true }),
      branchFromTurn: async () => ({ ok: true, session: SIDE_CHAT_SESSION }),
      cleanupSessionCopy: async () => undefined,
      abandonSessionCopy: async () => undefined,
      compact: async () => ({
        kind: 'finished' as const,
        turn: {
          sessionId: SIDE_CHAT_SESSION.id,
          turnId: 'story-side-chat-compact-turn',
          runId: 'story-side-chat-compact-run',
          status: 'completed' as const,
          terminalEventId: 'story-side-chat-compact-complete',
          contextCompactionOutcome: {
            kind: 'unchanged' as const,
            reason: 'already_current',
          },
        },
        outcome: { kind: 'unchanged' as const, reason: 'already_current' },
      }),
      send: async () => ({ ok: true, turnId: 'story-side-chat-turn' }),
      stop: async () => undefined,
      steer: async () => ({ kind: 'started', turnId: 'story-side-chat-turn' }),
      setPermissionMode: async (_sessionId, mode) => ({
        ...SIDE_CHAT_SESSION,
        permissionMode: mode,
      }),
      regenerateTurn: async () => undefined,
      respondToSandboxBoundary: async () => undefined,
      respondToClientCapability: async () => undefined,
      respondToUserQuestion: async () => undefined,
      subscribeEvents: (_sessionId, _handler, onSeeded) => {
        onSeeded?.();
        return unsubscribe();
      },
      subscribeSessionChanges: unsubscribe,
    },
  });
  return (Story) => (
    <WorkbarServicesProvider services={services}>
      <Story />
    </WorkbarServicesProvider>
  );
}

/**
 * The AppShell grid the workbar really lives in, with an empty conversation
 * column. Its 990px media query is what stacks the column in narrow windows.
 */
function Workbar(props: {
  tab?: SessionWorkbarTabKind;
  sourceSession?: SessionSummary;
  /** Overrides the restored column width, the way the resize handle does. */
  width?: number;
}) {
  const emptyTabsState = createSessionWorkbarTabsState();
  let tab: SessionWorkbarTab | undefined;
  let quotes: QuoteCompanionPanelState[] | undefined;
  if (props.tab === 'terminal') {
    tab = {
      id: terminalSessionWorkbarTabId(TERMINAL_REF),
      kind: 'terminal',
      ordinal: 1,
      resourceRef: TERMINAL_REF,
      ownerSessionId: SESSION_ID,
    };
  } else if (props.tab === 'side-chat') {
    tab = {
      id: `side-chat:${SIDE_CHAT_PANEL_ID}`,
      kind: 'side-chat',
      ordinal: 1,
    };
    quotes = [
      {
        id: SIDE_CHAT_PANEL_ID,
        sourceSessionId: SESSION_ID,
        quotes: [],
      },
    ];
  }
  const tabsState = tab
    ? createSessionWorkbarTabsState([tab], tab.id)
    : props.tab && props.tab !== 'side-chat'
      ? openStaticSessionWorkbarTab(emptyTabsState, props.tab)
      : emptyTabsState;
  return (
    <ToastProvider>
      <div
        className="maka-detail-with-artifacts"
        style={{
          // Fill the preview viewport like AppShell fills the window; a fixed
          // height pushes the stacked workbar below the fold in short windows.
          height: '100dvh',
          ...(props.width ? { '--maka-session-workbar-width': `${props.width}px` } : {}),
        } as CSSProperties}
      >
        <div className="mainColumn" />
        <WorkbarSurface
          sessionId={SESSION_ID}
          hidden={false}
          onDismissPanel={noop}
          panelsState={createSessionWorkbarPanelsState(tabsState)}
          rightCollapsed={false}
          bottomOpen={false}
          onActivateTab={noop}
          onCloseTab={noop}
          onCloseTabs={noop}
          onReorderTab={noop}
          onMoveTab={noop}
          onMoveTabToPanel={noop}
          onPinTab={noop}
          onOpenLauncher={noop}
          onRequestOpenTab={noop}
          confirmBypass={async () => true}
          quotes={quotes}
          sourceSession={
            props.sourceSession ??
            (props.tab === 'side-chat' ? TOOL_PICKER_SOURCE_SESSION : undefined)
          }
        />
      </div>
    </ToastProvider>
  );
}

const meta = {
  title: 'Product/Session Workbar',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

// Real path: sidebar → a session → expand an empty workbar. The picker is the
// workbar's empty content, composed entirely from Astryx List primitives.
export const ToolPicker: Story = {
  decorators: [bridge()],
  render: () => <Workbar sourceSession={TOOL_PICKER_SOURCE_SESSION} />,
};

// Real path: 任务工作栏 → 变更, showing the live branch comparison from the
// session cwd. The panel is Git-backed; no message or tool-result fixture is
// involved in this story.
export const Changes: Story = {
  decorators: [bridge()],
  render: () => <Workbar tab="review" />,
};

// Real path: 任务工作栏 → 变更 on a session whose branch matches its base. The
// panel's own empty state (icon + help), not a spinner and not an error.
export const ChangesEmpty: Story = {
  decorators: [bridge({ review: { ok: true, snapshot: emptyGitReviewSnapshot } })],
  render: () => <Workbar tab="review" />,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText('当前 Git 工作区没有变化');
  },
};

// Real path: 任务工作栏 → 变更 when `review.read` rejects (the git command
// failed); the error takes a Banner with 重试, the same shape as
// TasksLoadFailed — not an empty state.
export const ChangesLoadFailed: Story = {
  decorators: [bridge({ reviewFail: true })],
  render: () => <Workbar tab="review" />,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole('button', { name: '重试' });
  },
};

// Real path: 任务工作栏 → 变更 when the session cwd is not a Git repository. A
// source that cannot be read is a failure (error Banner + 重试), not an
// absence — the other read reasons (workspace unavailable, unborn repo,
// invalid base branch, git failed) share this branch.
export const ChangesSourceNotGit: Story = {
  decorators: [bridge({ review: { ok: false, reason: 'not_git_repository' } })],
  render: () => <Workbar tab="review" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('当前任务目录不是 Git 仓库');
    await canvas.findByRole('button', { name: '重试' });
  },
};

// Real path: 任务工作栏 → 变更 on a changeset so large the source capped its
// file list — the snapshot-level 变化过多 banner. The per-file line cap is a
// separate authority (see ChangesFileLineCap), not combined here.
export const ChangesTruncated: Story = {
  decorators: [bridge({ review: { ok: true, snapshot: sourceTruncatedGitReviewSnapshot } })],
  render: () => <Workbar tab="review" />,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText('变化过多，仅显示前一部分文件');
  },
};

// Real path: 任务工作栏 → 变更 with one file whose body runs past the 500-line
// cap — expanding it clips the body and notes the hidden remainder. The
// snapshot is NOT truncated, so only the per-file authority fires (no 变化过多
// banner).
export const ChangesFileLineCap: Story = {
  decorators: [bridge({ review: { ok: true, snapshot: fileLineCapGitReviewSnapshot } })],
  render: () => <Workbar tab="review" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const file = await canvas.findByText('src/generated/catalog.ts');
    expect(canvas.queryByText('变化过多，仅显示前一部分文件')).toBeNull();
    await userEvent.click(file);
    await canvas.findByText(/另有 \d+ 行未显示/);
  },
};

// Real path: 任务工作栏 → 变更 across the diff shapes a routine review never
// shows — binary, rename, deletion, no-newline-at-EOF, and a very long minified
// line — each rendered by the same DiffCodePreview.
export const ChangesEdgeContent: Story = {
  decorators: [bridge({ review: { ok: true, snapshot: edgeGitReviewSnapshot } })],
  render: () => <Workbar tab="review" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Expand each edge file in turn (the group is single-open) and confirm its
    // OWN body renders through the diff surface — scoped to that file's row,
    // since collapsed rows keep their diff mounted.
    const expectDiffBody = async (path: string, marker: string) => {
      await userEvent.click(await canvas.findByText(path));
      await waitFor(() => {
        const row = Array.from(
          canvasElement.querySelectorAll<HTMLElement>('.maka-session-review-file'),
        ).find((el) => el.textContent?.includes(path));
        expect(row?.querySelector('.maka-session-review-diff')?.textContent ?? '').toContain(marker);
      });
    };
    await expectDiffBody('assets/logo.png', 'Binary files a/assets/logo.png and b/assets/logo.png differ');
    await expectDiffBody('src/renamed-module.ts', 'rename from src/old-module.ts');
    await expectDiffBody('src/deprecated.ts', 'export function legacy');
    await expectDiffBody('config/version', 'No newline at end of file');
    await expectDiffBody('src/minified.bundle.js', 'PAYLOAD');
  },
};

// Real path: 任务工作栏 → 终端 after Desktop has created a PTY resource. The
// service fake hydrates the real xterm surface without an Electron bridge.
export const Terminal: Story = {
  decorators: [bridge()],
  render: () => <Workbar tab="terminal" />,
};

// Real path: 任务工作栏 → 终端 when `terminal.attach` finds no live resource
// (it resolves to null); the panel raises its load-failed Banner over the
// terminal surface instead of a silently blank pane.
export const TerminalLoadFailed: Story = {
  decorators: [bridge({ terminalAttach: 'missing' })],
  render: () => <Workbar tab="terminal" />,
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.textContent).toContain('无法读取终端运行'));
  },
};

// Real path: 任务工作栏 → 终端 after a long-running build — hundreds of lines of
// scrollback the fresh-shell story never shows.
export const TerminalLongScrollback: Story = {
  decorators: [bridge({ terminalBuffer: LONG_TERMINAL_BUFFER })],
  render: () => <Workbar tab="terminal" />,
};

// Real path: 任务工作栏 → 终端 rendering coloured, bold, and carriage-return
// progress output — the ANSI control sequences a plain command line omits.
export const TerminalRichOutput: Story = {
  decorators: [bridge({ terminalBuffer: RICH_TERMINAL_BUFFER })],
  render: () => <Workbar tab="terminal" />,
};

// Real path: 任务工作栏 → 终端 when a keystroke cannot reach the PTY
// (`terminal.write` rejects). Typing surfaces the panel's write-failed Banner.
// Input is driven through xterm's own helper textarea — the same handle the
// accessibility-runtime story uses — so this is genuinely reachable from a
// mounted story.
export const TerminalWriteFailed: Story = {
  decorators: [bridge({ terminalWriteFails: true })],
  render: () => <Workbar tab="terminal" />,
  play: async ({ canvasElement }) => {
    const textarea = await waitFor(() => {
      const el = canvasElement.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
      if (!el) throw new Error('xterm helper textarea not ready');
      return el;
    });
    textarea.focus();
    await userEvent.keyboard('echo hi');
    await waitFor(() => expect(canvasElement.textContent).toContain('无法发送终端输入'));
  },
};

// Real path: sidebar → a session → 展开任务工作栏, landing on the tab the app
// restored. Tasks is the default: an in-progress root, a child claimed and
// blocked by a subagent, and the finished ones folded into 最近结束.
export const Tasks: Story = {
  decorators: [bridge()],
  render: () => <Workbar tab="tasks" />,
};

// Real path: 任务工作栏 → 任务 on a session whose agent never wrote a task.
export const TasksEmpty: Story = {
  decorators: [bridge({ tasks: [] })],
  render: () => <Workbar tab="tasks" />,
};

// Real path: 任务工作栏 → 任务 when `tasks.list` rejects; 重试 re-runs the read.
export const TasksLoadFailed: Story = {
  decorators: [bridge({ tasksFail: true })],
  render: () => <Workbar tab="tasks" />,
};

// Storybook cannot host the native WebContentsView, so these pin what the panel
// itself draws — chrome and empty state — inside the real workbar shell.
export const BrowserEmpty: Story = {
  decorators: [bridge()],
  render: () => <Workbar tab="browser" />,
};

// The first navigation: hasPage is derived from the URL, still empty until the
// page commits, so the empty state and a live 停止 control share a frame.
export const BrowserLoading: Story = {
  decorators: [bridge({ browserState: { ...EMPTY_BROWSER_STATE, loading: true } })],
  render: () => <Workbar tab="browser" />,
};

// A committed page. The strip below the toolbar is blank here because the native
// view owns that rect in the app.
export const BrowserLoaded: Story = {
  decorators: [bridge({ browserState: LOADED_BROWSER_STATE })],
  render: () => <Workbar tab="browser" />,
};

// An http page, where `secure` turns into Astryx's warning status on the field.
export const BrowserInsecure: Story = {
  decorators: [bridge({
    browserState: { ...LOADED_BROWSER_STATE, url: 'http://192.168.1.10:8080/dashboard', title: 'Local dashboard', secure: false },
  })],
  render: () => <Workbar tab="browser" />,
};

// The column's 320px floor — the least room the toolbar row ever gets.
export const BrowserAtColumnFloor: Story = {
  decorators: [bridge({ browserState: LOADED_BROWSER_STATE })],
  render: () => <Workbar tab="browser" width={320} />,
};

// The width the resize handle lands on most often, between the floor and default.
export const BrowserAt400: Story = {
  decorators: [bridge({ browserState: LOADED_BROWSER_STATE })],
  render: () => <Workbar tab="browser" width={400} />,
};

// Below 990px the grid stacks the same right-placement column under the
// conversation: full width, capped at 42dvh. Storybook-UI only: the smoke lane
// loads iframes at 1280px, above the stack point, so it renders wide there.
export const BrowserStacked: Story = {
  parameters: { viewport: { options: STACKED_WINDOW_VIEWPORT } },
  globals: { viewport: { value: 'makaStackedWindow', isRotated: false } },
  decorators: [bridge({ browserState: LOADED_BROWSER_STATE })],
  render: () => <Workbar tab="browser" />,
};
// Real path: 任务工作栏 → 浏览器 mid-history — the one nav-control combination
// the other browser stories never show: forward enabled, not just back.
export const BrowserCanGoForward: Story = {
  decorators: [bridge({ browserState: { ...LOADED_BROWSER_STATE, canGoForward: true } })],
  render: () => <Workbar tab="browser" />,
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(within(canvasElement).getByRole('button', { name: '浏览器前进' })).toBeEnabled(),
    );
  },
};

// Real path: 任务工作栏 → 浏览器 on a page with a very long URL and title, at the
// column's 320px floor — the address field must keep the URL legible instead of
// pushing the toolbar controls out.
export const BrowserLongUrl: Story = {
  decorators: [
    bridge({
      browserState: { ...LOADED_BROWSER_STATE, url: LONG_BROWSER_URL, title: LONG_BROWSER_TITLE },
    }),
  ],
  render: () => <Workbar tab="browser" width={320} />,
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(within(canvasElement).getByRole('textbox', { name: '浏览器地址' })).toHaveValue(
        LONG_BROWSER_URL,
      ),
    );
  },
};

// Real path: 任务工作栏 → 浏览器 when the typed address is not an HTTP(S) URL. The
// embedded browser rejects it before navigating and raises the "无法打开地址"
// toast — a failure a bare loaded page never shows.
export const BrowserInvalidAddress: Story = {
  decorators: [bridge({ browserState: EMPTY_BROWSER_STATE })],
  render: () => <Workbar tab="browser" />,
  play: async ({ canvasElement }) => {
    const address = await within(canvasElement).findByRole('textbox', { name: '浏览器地址' });
    await userEvent.type(address, 'mailto:team@maka.apache.org{Enter}');
    await within(document.body).findByText('无法打开地址');
  },
};

// Real path: 任务工作栏 → 浏览器 when a valid address fails to load (navigate
// rejects); the panel raises the "浏览器导航失败" toast.
export const BrowserNavigationFailed: Story = {
  decorators: [bridge({ browserState: LOADED_BROWSER_STATE, browserNavigateFails: true })],
  render: () => <Workbar tab="browser" />,
  play: async ({ canvasElement }) => {
    const address = await within(canvasElement).findByRole('textbox', { name: '浏览器地址' });
    await userEvent.clear(address);
    await userEvent.type(address, 'https://example.com/status{Enter}');
    await within(document.body).findByText('浏览器导航失败');
  },
};

// Real path: 任务工作栏 → 文件, on a session whose agent wrote artifacts. The
// count in the tab is the pane's own filtered total, reported upward.
// The pane's empty state renders the same EmptyState as TraceEmpty below, so it
// is not a second story.
export const Files: Story = {
  decorators: [bridge()],
  render: () => <Workbar tab="files" />,
};

// Real path: 任务工作栏 → 侧边对话. The fork and transcript boundary are both
// supplied by WorkbarServices, so the real Composer mounts without window.maka.
export const SideChat: Story = {
  decorators: [bridge()],
  render: () => <Workbar tab="side-chat" />,
};

// Real path: 任务工作栏 → 追踪, on a session that has run turns — the overview
// reads a context budget, token/cache figures and the session's facts off a
// retried model call and a post-compaction call, while a turn that failed on a
// denied tool sits in the raw record under the coverage notice the projection
// raises when records are missing.
export const Trace: Story = {
  decorators: [bridge({ trace: populatedTrace, context: populatedContext })],
  render: () => <Workbar tab="inspector" />,
};

// Real path: resize the right workbar to its 320px floor while a failed turn
// is visible. The timestamp owns the first row; the failure and measurement
// share the second without squeezing the failure into a vertical word.
export const TraceMinimumWidth: Story = {
  decorators: [bridge({ trace: narrowTrace, context: populatedContext })],
  render: () => <Workbar tab="inspector" width={320} />,
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      const failure = canvasElement.querySelector<HTMLElement>(
        '[data-maka-contract="session-inspector-turn-failed"]',
      );
      const turn = failure?.closest<HTMLElement>(
        '[data-maka-contract="session-inspector-turn"]',
      );
      const label = turn?.querySelector<HTMLElement>('.maka-inspector-turn-label');
      const meta = turn?.querySelector<HTMLElement>('.maka-inspector-turn-meta');
      expect(failure).not.toBeNull();
      expect(turn).not.toBeNull();
      expect(label).not.toBeNull();
      expect(meta).not.toBeNull();
      if (!failure || !turn || !label || !meta) return;

      const failureRect = failure.getBoundingClientRect();
      const labelRect = label.getBoundingClientRect();
      const metaRect = meta.getBoundingClientRect();
      expect(failureRect.top).toBeGreaterThan(labelRect.top);
      expect(Math.abs(failureRect.top - metaRect.top)).toBeLessThanOrEqual(1);
      expect(failureRect.height).toBeLessThanOrEqual(metaRect.height + 1);
      expect(turn.scrollWidth).toBeLessThanOrEqual(turn.clientWidth);
    });
  },
};

// Real path: the first bounded page of a longer trace. The continuation control
// sits before the ascending timeline because earlier records are inserted at
// that edge, not after the newest turn.
export const TraceMoreHistory: Story = {
  decorators: [
    bridge({
      trace: populatedTrace,
      traceNextCursor: 'older-session-trace-page',
      context: populatedContext,
    }),
  ],
  render: () => <Workbar tab="inspector" />,
};

// Real path: 任务工作栏 → 追踪 on a long session whose latest call sits near the
// top of its window — the tier the context bands and their legend switch to
// before a compaction, and the state a reader is most likely to open the tab
// for. Same session as Trace, sized differently, so the two read side by side.
export const TraceContextNearLimit: Story = {
  decorators: [bridge({ trace: populatedTrace, context: nearLimitContext })],
  render: () => <Workbar tab="inspector" />,
};

// Real path: 任务工作栏 → 追踪 on a session recorded before tool schemas carried
// a name — the shape of every ledger written prior to #2323. The composition
// block still has to show those bytes, as unnamed tools rather than as a
// missing category, which is what gating the tool list on the NAMED rows alone
// silently broke.
export const TraceUnnamedTools: Story = {
  decorators: [bridge({ trace: populatedTrace, context: unnamedToolsContext })],
  render: () => <Workbar tab="inspector" />,
};

// Real path: 任务工作栏 → 追踪 when the durable metering record names the latest
// request but its best-effort capture never landed — the composition block has
// to SAY so, since an absent section reads as "nothing to explain" and a zero
// reads as an empty prompt.
export const TraceCompositionUnrecorded: Story = {
  decorators: [bridge({ trace: populatedTrace, context: unrecordedContext })],
  render: () => <Workbar tab="inspector" />,
};

// Real path: 任务工作栏 → 追踪 on a session that has not run a turn yet.
export const TraceEmpty: Story = {
  decorators: [bridge()],
  render: () => <Workbar tab="inspector" />,
};

// Real path: 任务工作栏 → 追踪 when `inspector.trace` reports a failed read (an
// unreadable or partially written run ledger); retry lives on the banner.
export const TraceReadFailed: Story = {
  decorators: [bridge({ traceFail: true })],
  render: () => <Workbar tab="inspector" />,
};
