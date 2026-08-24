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
  McpOAuthConfig,
  McpProtocolPreference,
  McpServerConfig,
  McpServerStatus,
} from '@maka/core/mcp';
import { isMcpStdioConfig, resolveMcpRemoteProtocolPreference } from '@maka/core/mcp';
import type { McpCopy } from './locales/mcp-copy.js';
import { formatCommandLine, parseCommandLine } from './mcp-command-line.js';

export type McpEditorDraft = {
  id: string;
  kind: 'stdio' | 'remote';
  enabled: boolean;
  commandLine: string;
  cwd: string;
  env: string;
  url: string;
  transport: 'auto' | 'streamable-http' | 'sse';
  protocol: McpProtocolPreference;
  headers: string;
  /** Opaque round-trip state: the editor has no OAuth fields, but an
   * edit → save of an OAuth-configured server must not delete the block
   * (the masked clientSecret sentinel restores from disk in main). */
  oauth?: McpOAuthConfig;
};

export function createEmptyMcpDraft(): McpEditorDraft {
  return {
    id: '',
    kind: 'stdio',
    enabled: true,
    commandLine: '',
    cwd: '',
    env: '',
    url: '',
    transport: 'auto',
    protocol: 'auto',
    headers: '',
  };
}

export function mcpDraftFromConfig(id: string, config: McpServerConfig): McpEditorDraft {
  if (isMcpStdioConfig(config)) {
    return {
      ...createEmptyMcpDraft(),
      id,
      enabled: config.enabled !== false,
      commandLine: formatCommandLine(config.command, config.args ?? []),
      cwd: config.cwd ?? '',
      env: formatMap(config.env),
    };
  }
  return {
    ...createEmptyMcpDraft(),
    id,
    kind: 'remote',
    enabled: config.enabled !== false,
    url: config.url,
    transport: config.transport ?? 'auto',
    // An omitted preference is the compatibility-preserving legacy posture,
    // not the default for a newly-authored remote entry.
    protocol: resolveMcpRemoteProtocolPreference(config),
    headers: formatMap(config.headers),
    ...(config.oauth ? { oauth: config.oauth } : {}),
  };
}

export function withMcpDraftTransport(
  draft: McpEditorDraft,
  transport: McpEditorDraft['transport'],
): McpEditorDraft {
  return {
    ...draft,
    transport,
    // Legacy HTTP+SSE is not a modern negotiation transport. Converge the
    // draft as soon as the transport changes so the disabled protocol picker
    // always describes the value that will be persisted.
    ...(transport === 'sse' ? { protocol: 'legacy' as const } : {}),
  };
}

export function mcpConfigFromDraft(draft: McpEditorDraft, copy: McpCopy): McpServerConfig {
  if (draft.kind === 'stdio') {
    const parsed = parseCommandLine(draft.commandLine);
    // Validation runs before save, so an unbalanced quote cannot reach here
    // through the dialog; the throw keeps other callers honest.
    if (!parsed.ok) throw new Error(copy.editor.unbalancedQuote);
    return {
      enabled: draft.enabled,
      command: parsed.command,
      args: parsed.args,
      ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
      env: parseMap(draft.env, copy),
    };
  }
  return {
    enabled: draft.enabled,
    url: draft.url.trim(),
    transport: draft.transport,
    protocol: draft.transport === 'sse' ? 'legacy' : draft.protocol,
    headers: parseMap(draft.headers, copy),
    ...(draft.oauth ? { oauth: draft.oauth } : {}),
  };
}

export function presentMcpNegotiatedProtocol(
  status: McpServerStatus | undefined,
  copy: McpCopy,
): string | undefined {
  if (status?.state !== 'connected' || !status.negotiatedProtocol) return undefined;
  return copy.detail.negotiatedProtocol(
    status.negotiatedProtocol.era,
    status.negotiatedProtocol.revision,
  );
}

function parseMap(value: string, copy: McpCopy): Record<string, string> {
  return Object.fromEntries(
    value
      .split(/\r?\n/u)
      .filter((line) => line.trim())
      .map((line, index) => {
        const separator = line.indexOf('=');
        if (separator <= 0) throw new Error(copy.errors.mapLine(index + 1));
        return [line.slice(0, separator).trim(), line.slice(separator + 1)];
      }),
  );
}

function formatMap(value?: Record<string, string>): string {
  return Object.entries(value ?? {})
    .map(([key, item]) => `${key}=${item}`)
    .join('\n');
}
