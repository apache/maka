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
  AgentMcpConfigurationChange,
  AgentMcpConfigurationEntry,
} from '../../../../../../packages/plugin-sdk/src/generated/runtime';
import type { SettingsRpc } from './rpc';

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
  if (result.kind !== 'saved')
    throw new Error(result.kind === 'rejected' ? result.reason : result.kind);
}
