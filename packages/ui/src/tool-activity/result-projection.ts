import { isShellOutput } from '@maka/core/shell-run';
import { type UiLocale } from '@maka/core/ui-locale';
import type { ToolActivityItem } from '../materialize.js';
import { formatQuietJsonValue } from './builtin-preview.js';
import { isConnectorTool } from './display-name.js';
import { getToolActivityCopy } from './copy.js';

export function extractErrorText(result: ToolActivityItem['result'], locale: UiLocale): string {
  if (!result) return '';
  switch (result.kind) {
    case 'text':
      return result.text;
    case 'json': {
      // Same quiet formatter as the panel — never dump escaped JSON braces.
      const quiet = formatQuietJsonValue(result.value, locale);
      return quiet.headline ? `${quiet.headline}\n${quiet.body}` : quiet.body;
    }
    case 'terminal': {
      const output = isShellOutput(result.output) ? result.output : undefined;
      return result.failureMessage
        || (output?.mode === 'pipes'
          ? output.stderr || output.stdout
          : output?.screen || output?.scrollback)
        || (result.exitCode === undefined ? result.status : `exit ${result.exitCode}`);
    }
    case 'file_diff':
      return result.diff;
    case 'rive_workflow':
      return result.error
        ? [result.summary, result.error.reason, result.error.message].filter(Boolean).join('\n')
        : result.summary;
    default:
      return result.kind;
  }
}

export function isPermissionDeniedToolResult(result: ToolActivityItem['result']): boolean {
  if (result?.kind !== 'text') return false;
  return /^(User denied permission(?: request)?|用户已拒绝权限请求)$/.test(result.text.trim());
}

/**
 * Result kinds (or tool-specific cards) that already paint their own chrome —
 * never nest them inside the shared quiet well.
 */
export function resultOwnsOwnPanel(item: ToolActivityItem): boolean {
  const result = item.result;
  if (!result) return false;
  if (isConnectorTool(item.toolName) && result.kind === 'json') return true;
  switch (result.kind) {
    case 'terminal':
    case 'shell_run':
    case 'explore_agent':
    case 'web_search':
    case 'web_search_error':
    case 'file_diff':
    case 'rive_workflow':
      return true;
    default:
      return false;
  }
}

export function isCancelledToolResult(result: ToolActivityItem['result']): boolean {
  if (!result) return false;
  if (result.kind === 'terminal' || result.kind === 'shell_run') {
    return result.status === 'cancelled';
  }
  if (result.kind === 'agent_swarm') return result.status === 'cancelled';
  return false;
}

function resultHasCapturedStreams(result: ToolActivityItem['result']): boolean {
  if (!result) return false;
  if (result.kind === 'terminal' || result.kind === 'shell_run') {
    const output = isShellOutput(result.output) ? result.output : undefined;
    if (output === undefined) return false;
    return output.mode === 'pty'
      ? output.screen.length > 0 || output.scrollback.length > 0 || Boolean(output.lastAlternateScreen)
      : output.stdout.length > 0 || output.stderr.length > 0;
  }
  return true;
}

/**
 * Background Bash returns an empty shell_run body; keep the live chunks the
 * user already saw by filling empty stdout/stderr from outputChunks. Also
 * forward truncation / redaction hints so settled preview matches live.
 */
export function withLiveStreamFallback(
  result: NonNullable<ToolActivityItem['result']>,
  chunks: ToolActivityItem['outputChunks'] | undefined,
  options?: { truncated?: boolean; locale?: UiLocale },
): NonNullable<ToolActivityItem['result']> {
  if (result.kind !== 'terminal' && result.kind !== 'shell_run') return result;
  if (resultHasCapturedStreams(result)) return result;
  const existing = isShellOutput(result.output) ? result.output : undefined;
  if (result.kind === 'terminal') {
    if (existing?.mode !== 'pipes') return result;
  } else if (result.mode !== 'pipes') {
    return result;
  }

  let stdout = '';
  let stderr = '';
  let anyRedacted = false;
  for (const chunk of chunks ?? []) {
    if (chunk.redacted) anyRedacted = true;
    if (chunk.stream === 'stderr') stderr += chunk.text;
    else stdout += chunk.text;
  }
  const truncated = existing?.mode === 'pipes' && existing.stdoutTruncated === true
    || options?.truncated === true;
  // Empty redacted/truncated live buffer still carries diagnosis — do not
  // early-return and drop "已脱敏" / "输出已截断".
  if (!stdout && !stderr && !anyRedacted && !truncated) return result;

  // Match live stream's "[已脱敏]" marker when a chunk was redacted
  // (including empty bodies that only suppressed secrets).
  if (anyRedacted) {
    const marker = getToolActivityCopy(options?.locale ?? 'zh').output.redacted;
    if (stdout.length > 0) stdout = `${stdout}${stdout.endsWith('\n') ? '' : '\n'}${marker}`;
    else if (stderr.length > 0) stderr = `${stderr}${stderr.endsWith('\n') ? '' : '\n'}${marker}`;
    else stdout = marker;
  }
  const output = {
    mode: 'pipes' as const,
    stdout,
    stderr,
    stdoutTruncated: truncated,
    stderrTruncated: existing?.mode === 'pipes' && existing.stderrTruncated === true,
    redacted: anyRedacted || (existing?.mode === 'pipes' && existing.redacted),
  };
  if (result.kind === 'shell_run') return { ...result, output };
  return { ...result, output };
}
