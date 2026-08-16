import { countDiffLineStats } from '@maka/core/unified-diff';
import type { ToolResultOutput } from './model-protocol.js';
import { toolResultOutput } from './tool-result-output.js';

/**
 * The diff is for the reader; the model is owed only what happened — a bounded
 * one-line summary. Editing is the hottest tool in the loop, so anything
 * attached to its output compounds across a turn; the full diff stays in the
 * durable result where the UI renders it.
 */
export function fileWriteToolResultToModelOutput(
  toolName: 'Write' | 'Edit' | 'FormatJson',
  output: unknown,
): ToolResultOutput {
  const summary = fileWriteToolResultSummary(toolName, output);
  return summary !== undefined ? { type: 'text', value: summary } : toolResultOutput(output, false);
}

/**
 * Replay counterpart of `fileWriteToolResultToModelOutput`. The durable ledger
 * keeps the full diff for the UI, and every model re-read of history — prior
 * turns, compaction, resume — flows through the replay plan. Without this
 * projection the model saw a one-line summary live but the full diff JSON on
 * every later turn, which is both a token leak and a shape inconsistency.
 * Same precedent as `projectBashToolResultForModel`.
 */
export function projectFileWriteToolResultForModel(toolName: string, output: unknown): unknown {
  if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'FormatJson') return output;
  return fileWriteToolResultSummary(toolName, output) ?? output;
}

function fileWriteToolResultSummary(
  toolName: 'Write' | 'Edit' | 'FormatJson',
  output: unknown,
): string | undefined {
  if (isFileDiff(output)) {
    const path = output.paths[0] ?? 'file';
    const { additions, deletions } = countDiffLineStats(output.diff);
    if (toolName === 'Write' && output.diff.startsWith('--- /dev/null'))
      return `Created ${path} (+${additions})`;
    const verb = toolName === 'Write' ? 'Overwrote' : toolName === 'Edit' ? 'Edited' : 'Formatted';
    return `${verb} ${path} (+${additions} -${deletions})`;
  }
  if (isFileWrite(output)) return `Wrote ${output.bytes} bytes to ${output.path}`;
  return undefined;
}

function isFileDiff(
  output: unknown,
): output is { kind: 'file_diff'; paths: string[]; diff: string } {
  return (
    typeof output === 'object' &&
    output !== null &&
    (output as { kind?: unknown }).kind === 'file_diff' &&
    Array.isArray((output as { paths?: unknown }).paths) &&
    typeof (output as { diff?: unknown }).diff === 'string'
  );
}

function isFileWrite(
  output: unknown,
): output is { kind: 'file_write'; path: string; bytes: number } {
  return (
    typeof output === 'object' &&
    output !== null &&
    (output as { kind?: unknown }).kind === 'file_write' &&
    typeof (output as { bytes?: unknown }).bytes === 'number'
  );
}
