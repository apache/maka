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

import type {
  SandboxDiagnosticCapability,
  SandboxDiagnosticsSnapshot,
} from '../sandbox/diagnostics.js';

const MAX_RENDERED_ROOTS = 16;
const MAX_RENDERED_PATH_CHARS = 1_024;

export function renderSandboxTurnTailPrompt(snapshot: SandboxDiagnosticsSnapshot): string {
  const lines = [
    'Maka runtime sandbox context (authoritative; enforced by the runtime):',
    '<sandbox_context>',
    `  Profile: ${sanitizeLine(snapshot.profile.name, 'profile name')}`,
    `  File system: ${snapshot.profile.fileSystem}`,
    `  Network: ${snapshot.profile.network}`,
    `  Working directory: ${renderPath(snapshot.profile.cwd, 'working directory')}`,
  ];

  const additionalRoots = snapshot.profile.workspaceRoots.filter(
    (root) => root !== snapshot.profile.cwd,
  );
  if (snapshot.profile.fileSystem === 'unrestricted') {
    lines.push('  Workspace access: unrestricted by Maka');
  } else if (snapshot.profile.fileSystem === 'disabled') {
    lines.push('  Workspace access: not managed by Maka');
  } else if (additionalRoots.length === 0) {
    lines.push('  Workspace access: constrained to the current workspace');
  } else {
    lines.push('  Workspace roots:');
    for (const root of additionalRoots.slice(0, MAX_RENDERED_ROOTS)) {
      lines.push(`    - ${renderPath(root, 'workspace root')}`);
    }
    if (additionalRoots.length > MAX_RENDERED_ROOTS) {
      lines.push(`    - ${additionalRoots.length - MAX_RENDERED_ROOTS} additional root(s) omitted`);
    }
  }

  lines.push(
    `  Protected metadata: ${renderList(snapshot.profile.protectedMetadata)}`,
    `  Command sandbox: ${renderCapability(snapshot.capabilities.command)}`,
    `  Filesystem sandbox: ${renderCapability(snapshot.capabilities.filesystem)}`,
    '</sandbox_context>',
  );
  return lines.join('\n');
}

function renderCapability(capability: SandboxDiagnosticCapability): string {
  const details = [
    capability.backend !== 'none' ? capability.backend : undefined,
    capability.selectionReason,
    capability.failure ? `${capability.failure.stage}:${capability.failure.reason}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return details.length === 0 ? capability.status : `${capability.status} (${details.join(', ')})`;
}

function renderList(values: readonly string[]): string {
  return values.length === 0
    ? 'none'
    : values.map((value) => sanitizeLine(value, 'metadata name')).join(', ');
}

function renderPath(value: string, label: string): string {
  if (value.length > MAX_RENDERED_PATH_CHARS) {
    throw new Error(`Sandbox context ${label} exceeds the rendering limit.`);
  }
  return sanitizeLine(value, label);
}

function sanitizeLine(value: string, label: string): string {
  if (!value || /[\r\n\t]/.test(value)) {
    throw new Error(`Sandbox context ${label} must be a non-empty single-line value.`);
  }
  return value;
}
