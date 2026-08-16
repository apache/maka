import { ProtocolError, SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import { formatMcpDiagnosticText, MCP_ERROR_DIAGNOSTIC_CODE_POINTS } from './diagnostic-text.js';

export class McpToolCallError extends Error {
  readonly serverId: string;
  readonly toolName: string;

  constructor(serverId: string, toolName: string, message: string, options?: ErrorOptions) {
    super(
      `MCP ${formatMcpDiagnosticText(serverId)}/${formatMcpDiagnosticText(
        toolName,
      )}: ${formatMcpDiagnosticText(message, MCP_ERROR_DIAGNOSTIC_CODE_POINTS)}`,
      options,
    );
    this.name = 'McpToolCallError';
    this.serverId = serverId;
    this.toolName = toolName;
  }
}

export function normalizeToolCallError(
  serverId: string,
  toolName: string,
  error: unknown,
  signal?: AbortSignal,
): Error {
  if (error instanceof McpToolCallError) return error;
  if (signal?.aborted) {
    return new McpToolCallError(serverId, toolName, 'tool call aborted', { cause: error });
  }
  if (error instanceof SdkError) {
    switch (error.code) {
      case SdkErrorCode.RequestTimeout:
        return new McpToolCallError(serverId, toolName, 'tool call timed out', { cause: error });
      case SdkErrorCode.InvalidResult:
        if (isLegacyDeferredToolResultError(error)) {
          return new McpToolCallError(
            serverId,
            toolName,
            'server returned an unsupported deferred tool result',
            { cause: error },
          );
        }
        return new McpToolCallError(serverId, toolName, 'server returned an invalid tool result', {
          cause: error,
        });
      case SdkErrorCode.UnsupportedResultType:
        return new McpToolCallError(
          serverId,
          toolName,
          'server returned an unsupported deferred tool result',
          { cause: error },
        );
      default:
        return new McpToolCallError(serverId, toolName, 'tool call failed', { cause: error });
    }
  }
  if (error instanceof ProtocolError) {
    return new McpToolCallError(
      serverId,
      toolName,
      'server rejected the tool call or returned an invalid result',
      { cause: error },
    );
  }
  return new McpToolCallError(serverId, toolName, 'tool call failed', { cause: error });
}

/**
 * SDK v2 rejects 2026-era result-family markers on a legacy connection at
 * its wire-schema boundary. Those responses never reach callTool(), so map
 * the pinned SDK's fixed validation diagnostic to Maka's deferred-result
 * boundary alongside UnsupportedResultType.
 */
function isLegacyDeferredToolResultError(error: SdkError): boolean {
  if (!error.message.startsWith('Invalid result for tools/call:')) return false;
  return ["'task'", "'inputRequests'", "'requestState'"].some((marker) =>
    error.message.includes(`body carries ${marker}`),
  );
}
