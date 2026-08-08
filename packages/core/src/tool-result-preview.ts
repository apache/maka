/**
 * Live-only open-facts decode/build for tool_result_preview.
 * Types live in events.ts; durable transcript uses ToolResultContent.
 */

import type { ToolResultContent, ToolResultPreviewContent } from './events.js';
import { isPermissionMode } from './permission.js';
import { defineObjectShape, hasExactShape, isOptionalString, isRecord } from './record-schema.js';

const SUBAGENT_PREVIEW_SHAPE = defineObjectShape<
  Extract<ToolResultPreviewContent, { kind: 'subagent' }>
>()(
  ['kind', 'childSessionId', 'agentName', 'turnId', 'status', 'permissionMode'],
  ['agentId', 'runId'],
);

/**
 * Decode live tool_result_preview content. Never use for transcript recovery.
 */
export function decodeToolResultPreviewContent(value: unknown): ToolResultPreviewContent {
  if (!isRecord(value) || value.kind !== 'subagent') {
    throw new Error('Invalid tool result preview content');
  }
  if (!isSubagentPreview(value)) throw new Error('Invalid tool result preview content');
  return value;
}

/**
 * Project open-facts into the activity row model (ToolResultContent with empty
 * bulk). Keeps ToolActivityItem.result as a single field without dual storage.
 */
export function materializeToolResultPreviewForActivity(
  content: ToolResultPreviewContent,
): ToolResultContent {
  return {
    kind: 'subagent',
    childSessionId: content.childSessionId,
    ...(content.agentId ? { agentId: content.agentId } : {}),
    agentName: content.agentName,
    turnId: content.turnId,
    ...(content.runId ? { runId: content.runId } : {}),
    status: content.status,
    permissionMode: content.permissionMode,
    summary: '',
    artifactIds: [],
  };
}

function isSubagentPreview(
  value: Record<string, unknown>,
): value is Extract<ToolResultPreviewContent, { kind: 'subagent' }> {
  return (
    hasExactShape(value, SUBAGENT_PREVIEW_SHAPE) &&
    typeof value.childSessionId === 'string' &&
    value.childSessionId.length > 0 &&
    isOptionalString(value.agentId) &&
    typeof value.agentName === 'string' &&
    typeof value.turnId === 'string' &&
    isOptionalString(value.runId) &&
    value.status === 'running' &&
    isPermissionMode(value.permissionMode)
  );
}
