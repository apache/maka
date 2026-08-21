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
