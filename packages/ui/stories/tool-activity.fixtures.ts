import type { ToolResultContent } from '@maka/core';
import type { ToolActivityItem, ToolOutputChunk } from '../src/materialize.js';

const NOW = 1_735_689_600_000;

const longStdout = Array.from({ length: 506 }, (_, index) => `stdout line ${index + 1}: package task output`).join('\n');

const terminalResult = {
  kind: 'terminal',
  cwd: '/Users/yuhan/workspace/oss/maka-agent',
  cmd: 'npm run -w @maka/desktop build-storybook',
  status: 'completed',
  exitCode: 0,
  output: pipeOutput(longStdout, 'storybook build completed with a large output preview\n'),
} satisfies ToolResultContent;

const terminalFailureResult = {
  kind: 'terminal',
  cwd: '/Users/yuhan/workspace/oss/maka-agent',
  cmd: 'npm run -w @maka/headless test',
  status: 'failed',
  exitCode: 1,
  output: pipeOutput('running headless tests\n', [
      'Error: expected verifier to receive task-run.json',
      'at packages/headless/src/verifier.ts:42:11',
    ].join('\n')),
} satisfies ToolResultContent;

function pipeOutput(stdout = '', stderr = '') {
  return {
    mode: 'pipes' as const,
    stdout,
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    redacted: false,
  };
}

const fileDiffResult = {
  kind: 'file_diff',
  paths: ['packages/ui/src/tool-activity.tsx', 'packages/ui/stories/tool-activity.stories.tsx'],
  diff: [
    'diff --git a/packages/ui/src/tool-activity.tsx b/packages/ui/src/tool-activity.tsx',
    '--- a/packages/ui/src/tool-activity.tsx',
    '+++ b/packages/ui/src/tool-activity.tsx',
    '@@ -139,7 +139,8 @@ export function ToolActivity(props: { items: ToolActivityItem[] }) {',
    '-              {item.intent && <p>{item.intent}</p>}',
    '+              {item.intent && !permissionDenied && (',
    '+                <p>{formatToolIntent(item.intent)}</p>',
    '+              )}',
    '             {item.args !== undefined && (',
  ].join('\n'),
} satisfies ToolResultContent;

const webSearchResult = {
  kind: 'web_search',
  provider: 'tavily',
  query: 'Maka Storybook ToolActivity review states',
  rows: [
    {
      title: 'Storybook interaction testing',
      url: 'https://storybook.js.org/docs/writing-tests/interaction-testing',
      snippet: 'Use stories to capture states that are hard to reproduce by driving the app.',
      source: 'storybook.js.org',
    },
    {
      title: 'Visual review checklist',
      url: 'https://example.com/design-review',
      snippet: 'Stable fixtures make spacing, hierarchy, and copy density easier to compare.',
      source: 'example.com',
    },
  ],
} satisfies ToolResultContent;

const webSearchErrorResult = {
  kind: 'web_search_error',
  ok: false,
  provider: 'tavily',
  query: 'latest package metadata',
  reason: 'invalid_credentials',
  message: 'Tavily rejected the saved API key.',
  credentialSource: 'saved',
} satisfies ToolResultContent;

const subagentResult = {
  kind: 'subagent',
  agentId: 'agent-review',
  agentName: 'Review Agent',
  turnId: 'turn-subagent',
  runId: 'run-subagent',
  status: 'completed',
  permissionMode: 'ask',
  summary: 'Reviewed the renderer story surface and found the missing ToolActivity state board.',
  artifactIds: ['artifact-summary'],
  startedAt: NOW - 18_000,
  completedAt: NOW,
  durationMs: 18_000,
  eventCount: 14,
} satisfies ToolResultContent;

const subagentWaitingResult = {
  kind: 'subagent',
  agentName: 'Explore Helper',
  turnId: 'turn-subagent-waiting',
  status: 'waiting_for_user',
  permissionMode: 'explore',
  summary: 'Waiting for approval before reading the requested path.',
  artifactIds: [],
  startedAt: NOW - 4_000,
  durationMs: 4_000,
} satisfies ToolResultContent;

const agentSwarmResult = {
  kind: 'agent_swarm',
  status: 'partial',
  items: [
    {
      itemId: 'runtime',
      index: 0,
      profile: 'local_read',
      started: true,
      agentName: 'Local Read',
      turnId: 'turn-swarm-runtime',
      runId: 'run-swarm-runtime',
      status: 'completed',
      summary: 'Verified that every child uses the shared spawnChildAgent permit boundary.',
      artifactIds: ['artifact-runtime-notes'],
      startedAt: NOW - 21_000,
      completedAt: NOW - 8_000,
      durationMs: 13_000,
    },
    {
      itemId: 'presentation',
      index: 1,
      profile: 'local_read',
      started: true,
      agentName: 'Local Read',
      turnId: 'turn-swarm-presentation',
      runId: 'run-swarm-presentation',
      status: 'completed',
      summary: 'Mapped the compact ToolResultPreview surface and its bounded output contracts.',
      artifactIds: [],
      startedAt: NOW - 21_000,
      completedAt: NOW - 3_000,
      durationMs: 18_000,
    },
    {
      itemId: 'telemetry',
      index: 2,
      profile: 'local_read',
      started: true,
      agentName: 'Local Read',
      turnId: 'turn-swarm-telemetry',
      runId: 'run-swarm-telemetry',
      status: 'failed',
      summary: 'The first telemetry probe was interrupted before it produced evidence.',
      artifactIds: [],
      startedAt: NOW - 21_000,
      completedAt: NOW,
      durationMs: 21_000,
      failureClass: 'ChildFailed',
    },
  ],
  startedAt: NOW - 21_000,
  completedAt: NOW,
  durationMs: 21_000,
} satisfies ToolResultContent;

const exploreAgentResult = {
  kind: 'explore_agent',
  ok: false,
  partial: true,
  terminalStatus: 'canceled_partial',
  mode: 'read_only',
  objective: 'Find every ToolActivity preview state needed for UI polish.',
  roots: ['packages/ui/src', 'packages/ui/stories'],
  queries: ['ToolActivity', 'ToolResultContent', 'previewVariants'],
  ignoredPaths: ['node_modules', 'dist'],
  stoppingCondition: 'Stopped after the candidate budget was reached.',
  limitReasons: ['candidate_budget'],
  filesDiscovered: 42,
  filesInspected: 12,
  filesSkipped: 6,
  sensitiveFilesSkipped: 1,
  bytesRead: 186_402,
  startedAt: NOW - 52_000,
  completedAt: NOW,
  durationMs: 52_000,
  progress: [
    'Scanned packages/ui/src/tool-activity.tsx for ToolResultContent branches.',
    'Collected representative result shapes from @maka/core events.',
    'Stopped before reading generated renderer output.',
  ],
  recentEvents: [
    { type: 'started', at: NOW - 52_000, message: 'Started read-only exploration.' },
    { type: 'scan', at: NOW - 41_000, message: 'Matched ToolActivity preview branches.' },
    { type: 'checkpoint', at: NOW - 12_000, message: 'Candidate budget reached with partial evidence.' },
    { type: 'aborted', at: NOW, message: 'Canceled with partial findings preserved.' },
  ],
  evidence: [
    { type: 'match', path: 'packages/ui/src/tool-activity.tsx', line: 370, label: 'ToolResultPreview kind routing', score: 0.95 },
    { type: 'candidate', path: 'packages/ui/src/materialize.ts', label: 'ToolActivityItem shape', score: 0.87 },
  ],
  summary: 'ToolActivity already renders every important preview branch; Storybook needs fixed fixture states.',
  report: [
    'The UI surface is ready for a storyboard-only PR.',
    'No runtime or materialization changes are needed.',
    'Long output and permission-denied paths should be visible in the state board.',
  ].join('\n'),
  candidateFiles: [
    { path: 'packages/ui/src/tool-activity.tsx', score: 0.98, reasons: ['direct-component', 'preview-routing'] },
    { path: 'packages/core/src/events.ts', score: 0.91, reasons: ['result-shape'] },
    { path: 'packages/ui/src/materialize.ts', score: 0.84, reasons: ['item-shape'] },
  ],
  matches: [
    { path: 'packages/ui/src/tool-activity.tsx', line: 395, query: 'terminal', snippet: "if (content.kind === 'terminal')" },
    { path: 'packages/ui/src/tool-activity.tsx', line: 407, query: 'office_document', snippet: "if (content.kind === 'office_document')" },
  ],
  notes: ['Read-only mode kept production files untouched.', 'One sensitive path was skipped.'],
  reason: 'aborted',
  message: 'Exploration was canceled after collecting enough fixture evidence.',
} satisfies ToolResultContent;

const officeDocumentResult = {
  kind: 'office_document',
  ok: true,
  operation: 'inspect',
  path: 'docs/review-notes.docx',
  args: ['inspect', 'docs/review-notes.docx'],
  stdout: 'Title: Review Notes\nPages: 4\nTables: 2\nImages: 1',
  stderr: '',
} satisfies ToolResultContent;

const officeDocumentErrorResult = {
  kind: 'office_document',
  ok: false,
  operation: 'replace-text',
  path: 'docs/review-notes.docx',
  args: ['replace-text', 'docs/review-notes.docx', '--selector', 'missing-heading'],
  stdout: '',
  stderr: 'selector "missing-heading" matched no document nodes',
  truncated: true,
  reason: 'invalid_selector',
  message: 'The requested selector was not found.',
} satisfies ToolResultContent;

const liveOutputChunks: ToolOutputChunk[] = [
  { seq: 1, stream: 'stdout', text: 'installing dependencies\n', redacted: false, createdAt: NOW - 7_000 },
  { seq: 2, stream: 'stderr', text: 'warning: optional peer dependency not installed\n', redacted: false, createdAt: NOW - 6_000 },
  { seq: 3, stream: 'stdout', text: 'running build pipeline\n', redacted: false, createdAt: NOW - 5_000 },
  { seq: 4, stream: 'stderr', text: '', redacted: true, createdAt: NOW - 4_000 },
  { seq: 5, stream: 'stdout', text: 'waiting for Storybook static generation\n', redacted: false, createdAt: NOW - 3_000 },
];

function toolItem(item: ToolActivityItem): ToolActivityItem {
  return item;
}

export const statusOverviewItems = [
  toolItem({
    toolUseId: 'status-pending',
    toolName: 'read_file',
    displayName: 'Read file',
    intent: 'Open the target component before editing.',
    status: 'pending',
    args: { path: 'packages/ui/src/tool-activity.tsx' },
  }),
  toolItem({
    toolUseId: 'status-waiting',
    toolName: 'bash',
    displayName: 'Shell command',
    intent: 'Run a command that needs permission.',
    status: 'waiting_permission',
    args: { cmd: 'npm run typecheck' },
  }),
  toolItem({
    toolUseId: 'status-running',
    toolName: 'bash',
    displayName: 'Build Storybook',
    intent: 'Generate the static Storybook bundle.',
    status: 'running',
    args: { cmd: 'npm run -w @maka/desktop build-storybook' },
    outputChunks: liveOutputChunks.slice(0, 3),
  }),
  toolItem({
    toolUseId: 'status-completed',
    toolName: 'read_file',
    displayName: 'Read fixture',
    status: 'completed',
    args: { path: 'packages/ui/stories/tool-activity.fixtures.ts' },
    result: { kind: 'text', text: 'Fixture loaded successfully.' },
    durationMs: 842,
  }),
  toolItem({
    toolUseId: 'status-errored',
    toolName: 'bash',
    displayName: 'Headless test',
    status: 'errored',
    args: { cmd: 'npm run -w @maka/headless test' },
    result: terminalFailureResult,
    durationMs: 2_480,
  }),
  toolItem({
    toolUseId: 'status-interrupted',
    toolName: 'explore',
    displayName: 'Explore repository',
    status: 'interrupted',
    args: { roots: ['packages/ui/src'], query: 'ToolActivity' },
    result: { kind: 'text', text: 'The turn was interrupted after partial output was retained.' },
    durationMs: 9_360,
  }),
] satisfies ToolActivityItem[];

export const terminalAndLiveOutputItems = [
  toolItem({
    toolUseId: 'terminal-result',
    toolName: 'bash',
    displayName: 'Storybook build',
    intent: 'Build Storybook and keep long terminal output bounded.',
    status: 'completed',
    args: { cmd: terminalResult.cmd, cwd: terminalResult.cwd },
    result: terminalResult,
    durationMs: 31_240,
  }),
  toolItem({
    toolUseId: 'live-output',
    toolName: 'bash',
    displayName: 'Live output',
    intent: 'Stream interleaved stdout and stderr while the tool runs.',
    status: 'running',
    args: { cmd: 'npm run build' },
    outputChunks: liveOutputChunks,
    outputTruncated: true,
    durationMs: 8_120,
  }),
] satisfies ToolActivityItem[];

export const fileDiffAndWebSearchItems = [
  toolItem({
    toolUseId: 'file-diff',
    toolName: 'apply_patch',
    displayName: 'Patch preview',
    intent: 'Preview a file diff before committing.',
    status: 'completed',
    args: { files: fileDiffResult.paths },
    result: fileDiffResult,
    durationMs: 1_180,
  }),
  toolItem({
    toolUseId: 'web-search',
    toolName: 'web_search',
    displayName: 'Web search',
    intent: 'Find current external documentation for Storybook review flows.',
    status: 'completed',
    args: { query: webSearchResult.query, provider: webSearchResult.provider },
    result: webSearchResult,
    durationMs: 3_420,
  }),
  toolItem({
    toolUseId: 'web-search-error',
    toolName: 'web_search',
    displayName: 'Web search error',
    intent: 'Show credential repair guidance.',
    status: 'errored',
    args: { query: webSearchErrorResult.query, provider: webSearchErrorResult.provider },
    result: webSearchErrorResult,
    durationMs: 984,
  }),
] satisfies ToolActivityItem[];

export const subagentAndExploreItems = [
  toolItem({
    toolUseId: 'subagent-completed',
    toolName: 'spawn_subagent',
    displayName: 'Subagent review',
    intent: 'Delegate a bounded review to a foreground subagent.',
    status: 'completed',
    args: { agentName: subagentResult.agentName, objective: 'Review ToolActivity states' },
    result: subagentResult,
    durationMs: 18_000,
  }),
  toolItem({
    toolUseId: 'subagent-waiting',
    toolName: 'spawn_subagent',
    displayName: 'Subagent permission',
    intent: 'Wait for a child-agent permission decision.',
    status: 'waiting_permission',
    args: { agentName: subagentWaitingResult.agentName, permissionMode: subagentWaitingResult.permissionMode },
    result: subagentWaitingResult,
    durationMs: 4_000,
  }),
  toolItem({
    toolUseId: 'agent-swarm-partial',
    toolName: 'agent_swarm',
    displayName: 'Agent Swarm',
    intent: 'Inspect runtime, presentation, and telemetry independently, then synthesize.',
    status: 'completed',
    args: { items: 3, max_concurrency: 3 },
    result: agentSwarmResult,
    durationMs: 21_000,
  }),
  toolItem({
    toolUseId: 'explore-agent',
    toolName: 'explore_agent',
    displayName: 'Read-only explore',
    intent: 'Summarize partial findings with evidence and continuation copy.',
    status: 'interrupted',
    args: { objective: exploreAgentResult.objective, roots: exploreAgentResult.roots },
    result: exploreAgentResult,
    durationMs: 52_000,
  }),
] satisfies ToolActivityItem[];

export const officeDocumentItems = [
  toolItem({
    toolUseId: 'office-success',
    toolName: 'office_document',
    displayName: 'Inspect document',
    intent: 'Inspect a Word document without opening the desktop app.',
    status: 'completed',
    args: { operation: officeDocumentResult.operation, path: officeDocumentResult.path },
    result: officeDocumentResult,
    durationMs: 1_640,
  }),
  toolItem({
    toolUseId: 'office-error',
    toolName: 'office_document',
    displayName: 'Replace document text',
    intent: 'Show a failed Office operation with diagnostics.',
    status: 'errored',
    args: { operation: officeDocumentErrorResult.operation, path: officeDocumentErrorResult.path },
    result: officeDocumentErrorResult,
    durationMs: 2_940,
  }),
] satisfies ToolActivityItem[];

export const errorsAndPermissionDeniedItems = [
  toolItem({
    toolUseId: 'terminal-error',
    toolName: 'bash',
    displayName: 'Failing test',
    intent: 'Surface stderr and the error-copy affordance.',
    status: 'errored',
    args: { cmd: terminalFailureResult.cmd, cwd: terminalFailureResult.cwd },
    result: terminalFailureResult,
    durationMs: 2_480,
  }),
  toolItem({
    toolUseId: 'permission-denied',
    toolName: 'bash',
    displayName: 'Denied shell command',
    intent: 'This intent is hidden when the permission denial copy is rendered.',
    status: 'errored',
    args: { cmd: 'rm -rf dist' },
    result: { kind: 'text', text: 'User denied permission' },
    durationMs: 350,
  }),
] satisfies ToolActivityItem[];

export const denseMixedResultItems = [
  statusOverviewItems[2],
  terminalAndLiveOutputItems[0],
  fileDiffAndWebSearchItems[0],
  fileDiffAndWebSearchItems[1],
  subagentAndExploreItems[0],
  subagentAndExploreItems[2],
  officeDocumentItems[0],
  errorsAndPermissionDeniedItems[0],
] satisfies ToolActivityItem[];
