import type { ToolResultOutput } from './model-protocol.js';
import { toolResultOutput } from './tool-result-output.js';

/**
 * Keep the canonical Bash result intact for durable storage while removing the
 * command already present in the paired provider-visible Bash call.
 */
export function projectBashToolResultForModel(output: unknown): unknown {
  if (
    !output ||
    typeof output !== 'object' ||
    Array.isArray(output) ||
    (output as { kind?: unknown }).kind !== 'terminal'
  ) {
    return output;
  }
  const { cmd: _cmd, ...projected } = output as Record<string, unknown>;
  return projected;
}

export function bashToolResultToModelOutput(output: unknown): ToolResultOutput {
  return toolResultOutput(projectBashToolResultForModel(output), false);
}
