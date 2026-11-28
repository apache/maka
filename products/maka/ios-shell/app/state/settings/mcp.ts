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

import { tr } from '../../locale';
import type { ServiceMethods } from '../../../../../../packages/plugin-sdk/src/generated/methods';
import type {
  AgentMcpConfigurationChange,
  AgentMcpConfigurationEntry,
} from '../../../../../../packages/plugin-sdk/src/generated/runtime';
import { LocalizedSettingsError, type SettingsRpc } from './rpc';

// Settings inventory exposes the desktop JSON shape; preserve fields this form doesn't edit.
export type McpConfig = {
  type?: 'http' | 'stdio';
  command?: string;
  url?: string;
  cwd?: string;
  args?: string[];
  disabled?: boolean;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  passEnv?: string[];
  headerEnv?: Record<string, string>;
};

export function mcpConfig(entry?: AgentMcpConfigurationEntry): McpConfig {
  return (entry?.configuration ?? {}) as McpConfig;
}

export async function changeMcp(rpc: SettingsRpc, input: AgentMcpConfigurationChange) {
  const result = await rpc.mutate('agent', 'manageMcpServer', input);
  if (result.kind === 'saved') return;
  if (result.kind === 'changed')
    throw new LocalizedSettingsError('Refresh and try again.', { cause: result });
  throw new Error(
    input.change.kind === 'delete'
      ? tr('Could not remove the MCP server.')
      : tr('Could not save the MCP server.'),
    { cause: result },
  );
}

type ProjectMcp = Extract<
  ServiceMethods['agent']['projectMcp']['output'],
  { kind: 'configuration' }
>;

export function projectMcpSummary(proposal: ProjectMcp): string | null {
  const readable = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
  const names = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every(readable);
  if (
    !readable(proposal.path) ||
    !Array.isArray(proposal.servers) ||
    (!proposal.servers.length && !proposal.disabled?.length) ||
    !names(proposal.disabled)
  )
    return null;
  const clean = (value: string) =>
    value.replace(
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,
      (character) => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'),
    );
  const rows = [
    clean(proposal.path),
    tr(
      'These servers run outside the conversation sandbox and can run commands as your user or contact remote services. Full-access sessions can call their tools without further confirmation.',
    ),
  ];
  for (const server of proposal.servers) {
    if (
      !readable(server?.name) ||
      !readable(server.launch) ||
      !names(server.environment) ||
      !names(server.headers) ||
      !names(server.readOnlyTools) ||
      typeof server.preapproved !== 'boolean'
    )
      return null;
    rows.push(
      [
        clean(server.name) + ': ' + clean(server.launch),
        tr('Environment variables') +
          ': ' +
          (server.environment.map(clean).join(', ') || tr('None')),
        tr('HTTP headers') + ': ' + (server.headers.map(clean).join(', ') || tr('None')),
        tr('Tools declared read-only') +
          ': ' +
          (server.readOnlyTools.map(clean).join(', ') || tr('None')),
        ...(server.preapproved ? [tr('Tool calls are preapproved.')] : []),
      ].join('\n'),
    );
  }
  if (proposal.disabled.length)
    rows.push(tr('Disabled servers') + ': ' + proposal.disabled.map(clean).join(', '));
  return rows.join('\n\n');
}
