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

import type { PermissionMode } from '@maka/core/permission';
import type { SessionToolProfile } from '@maka/core/session';

const GUIDANCE_HEADING = '## Auto-mode tool guidance';

export interface AutoToolGuidanceInput {
  readonly permissionMode?: PermissionMode;
  readonly toolNames: readonly string[];
  readonly toolProfile?: SessionToolProfile;
  readonly shellAvailable?: boolean;
  readonly restrictedToolSurface?: boolean;
  readonly sideConversation?: boolean;
}

/**
 * Builds the mode-aware tool-selection guidance for an eligible main session.
 *
 * The caller supplies the final model-visible tool names. This module has no
 * execution or filesystem authority: it only decides whether to return a
 * deterministic prompt fragment and which available structured tools to name.
 */
export function resolveAutoToolGuidance(input: AutoToolGuidanceInput): string | undefined {
  if (input.permissionMode !== 'ask') return undefined;
  if (!input.toolNames.includes('Bash')) return undefined;
  if (input.shellAvailable === false) return undefined;
  if (input.toolProfile !== undefined) return undefined;
  if (input.restrictedToolSurface === true) return undefined;
  if (input.sideConversation === true) return undefined;

  const toolNames = new Set(input.toolNames);
  const inspectionTools = ['Read', 'Glob', 'Grep'].filter((name) => toolNames.has(name));
  const mutationTools = ['Edit', 'Write', 'apply_patch'].filter((name) => toolNames.has(name));
  const lines = [
    GUIDANCE_HEADING,
    "In Auto mode, choose the tool that best fits the operation while staying within Maka's current permission and sandbox boundary.",
    '- Prefer Bash and composable CLI workflows for batching, pipelines, transformations, large or generated payloads, or recovery when a structured tool cannot express the operation reliably.',
    inspectionTools.length > 0
      ? `- Prefer ${formatToolNames(inspectionTools)} for simple structured inspection.`
      : undefined,
    mutationTools.length > 0
      ? `- Prefer ${formatToolNames(mutationTools)} when path validation, reviewable diffs, or UI-integrated file changes are useful.`
      : undefined,
    '- Bash is not a permission bypass. Keep commands within the current sandbox, workspace, network, and approval policy; do not use shell indirection to evade those controls.',
    '- If Bash or another named tool is unavailable, use only the tools exposed in this session.',
  ];
  return lines.filter((line): line is string => line !== undefined).join('\n');
}

function formatToolNames(names: readonly string[]): string {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}
