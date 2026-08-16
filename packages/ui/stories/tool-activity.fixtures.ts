import type { ToolResultContent } from '@maka/core/events';
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
  cmd: 'npm run -w @maka/eval test',
  status: 'failed',
  exitCode: 1,
  output: pipeOutput(
    'running eval tests\n',
    ['Error: expected earliest valid attempt', 'at packages/eval/src/result.ts:42:11'].join('\n'),
  ),
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

// Background Bash (`run_in_background: true`) settles as `shell_run`, not
// `terminal`. It shares the command surface with the foreground and live paths,
// so the three belong in one story to compare.
const shellRunResult = {
  kind: 'shell_run',
  mode: 'pipes',
  ref: 'shell-7f21',
  cwd: '/Users/yuhan/workspace/oss/maka-agent',
  cmd: 'npm run -w @maka/ui test -- --watch',
  status: 'running',
  startedAt: NOW - 1_400,
  updatedAt: NOW,
  revision: 3,
  output: pipeOutput('watching packages/ui/src for changes\n341 passing\n'),
} satisfies ToolResultContent;

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
    toolUseId: 'status-long-running',
    toolName: 'bash',
    displayName: 'Shell command',
    intent: 'Run a command that has not returned yet.',
    status: 'running',
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
    displayName: 'Eval test',
    status: 'errored',
    args: { cmd: 'npm run -w @maka/eval test' },
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

/** The same shell command in all three shapes it can reach the detail panel in. */
export const shellCommandSurfaceItems = [
  toolItem({
    toolUseId: 'shell-surface-live',
    toolName: 'Bash',
    displayName: 'Live output',
    intent: 'Stream interleaved stdout and stderr while the tool runs.',
    status: 'running',
    args: { command: 'npm run build' },
    outputChunks: liveOutputChunks,
    outputTruncated: true,
    durationMs: 8_120,
  }),
  toolItem({
    toolUseId: 'shell-surface-terminal',
    toolName: 'Bash',
    displayName: 'Storybook build',
    intent: 'Foreground run that settled with long bounded output.',
    status: 'completed',
    args: { command: terminalResult.cmd },
    result: terminalResult,
    durationMs: 31_240,
  }),
  toolItem({
    toolUseId: 'shell-surface-background',
    toolName: 'Bash',
    displayName: 'Background watcher',
    intent: 'Background run tracked by ref instead of returning inline.',
    status: 'running',
    args: { command: shellRunResult.cmd, run_in_background: true },
    result: shellRunResult,
    durationMs: 1_400,
  }),
  toolItem({
    toolUseId: 'shell-surface-failed',
    toolName: 'Bash',
    displayName: 'Failing test',
    intent: 'Failure keeps the same surface and only re-tints its border.',
    status: 'errored',
    args: { command: terminalFailureResult.cmd },
    result: terminalFailureResult,
    durationMs: 2_480,
  }),
] satisfies ToolActivityItem[];

/**
 * What the runtime now produces for real Edit/Write calls (#2232): no
 * `diff --git` preamble, straight `---`/`+++` headers; `/dev/null` for a
 * created file. The collapsed rows are where the green `+N` / red `-N`
 * stats show.
 */
const editDiffResult = {
  kind: 'file_diff',
  paths: ['packages/ui/src/tool-activity.tsx'],
  diff: [
    '--- a/packages/ui/src/tool-activity.tsx',
    '+++ b/packages/ui/src/tool-activity.tsx',
    '@@ -286,7 +286,8 @@',
    '   const calls: ChatToolCallItem[] = items.map((item) => ({',
    '     key: item.toolUseId,',
    '     name: resolveToolDisplayName(item, locale),',
    '     status: astryxToolStatus(item),',
    '+    ...(item.result?.kind === \'file_diff\' ? diffRowStats(item.result.diff) : {}),',
    '     duration: formatDuration(item.durationMs) ?? undefined,',
    '     stats: outcomeWord(item, locale),',
    '     resultDetail: (',
  ].join('\n'),
} satisfies ToolResultContent;

const writeNewFileDiffResult = {
  kind: 'file_diff',
  paths: ['docs/tool-result-diff.md'],
  diff: [
    '--- /dev/null',
    '+++ b/docs/tool-result-diff.md',
    '@@ -0,0 +1,4 @@',
    '+# Tool result diffs',
    '+',
    '+Edit/Write/FormatJson carry a unified diff in their tool result,',
    '+rendered by FileDiffPreview on desktop and renderDiffResult in the TUI.',
  ].join('\n'),
} satisfies ToolResultContent;

const writeOverwriteDiffResult = {
  kind: 'file_diff',
  paths: ['.maka/config.json'],
  diff: [
    '--- a/.maka/config.json',
    '+++ b/.maka/config.json',
    '@@ -1,5 +1,5 @@',
    ' {',
    '   "theme": "dark",',
    '-  "model": "glm-5",',
    '+  "model": "glm-5.1",',
    '   "telemetry": false',
    ' }',
  ].join('\n'),
} satisfies ToolResultContent;

export const editWriteDiffItems = [
  toolItem({
    toolUseId: 'edit-diff',
    toolName: 'Edit',
    intent: 'Pass diff stats to the tool row.',
    status: 'completed',
    args: { path: 'packages/ui/src/tool-activity.tsx' },
    result: editDiffResult,
    durationMs: 220,
  }),
  toolItem({
    toolUseId: 'write-new-diff',
    toolName: 'Write',
    intent: 'Document the diff result kind.',
    status: 'completed',
    args: { path: 'docs/tool-result-diff.md' },
    result: writeNewFileDiffResult,
    durationMs: 160,
  }),
  toolItem({
    toolUseId: 'write-overwrite-diff',
    toolName: 'Write',
    intent: 'Bump the configured model version.',
    status: 'completed',
    args: { path: '.maka/config.json' },
    result: writeOverwriteDiffResult,
    durationMs: 140,
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
  fileDiffAndWebSearchItems[2],
  errorsAndPermissionDeniedItems[0],
] satisfies ToolActivityItem[];
