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

import { createHash } from 'node:crypto';
import type { McpToolBinding } from '@maka/core/mcp';

const MCP_TOOL_BINDING_PREFIX = 'mcpb1.';
const MAX_MCP_TOOL_BINDING_CHARS = 96;

export interface McpToolBindingIdentity {
  managerId: string;
  connectionGeneration: number;
  serverId: string;
  toolName: string;
  definitionFingerprint: string;
}

export interface McpParsedToolBinding {
  managerId: string;
  connectionGeneration: number;
}

export function createMcpToolBinding(identity: McpToolBindingIdentity): McpToolBinding {
  if (!isValidIdentity(identity)) throw new Error('Invalid MCP tool binding identity');
  const generation = identity.connectionGeneration.toString(36);
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        identity.managerId,
        identity.connectionGeneration,
        identity.serverId,
        identity.toolName,
        identity.definitionFingerprint,
      ]),
    )
    .digest('base64url');
  return `${MCP_TOOL_BINDING_PREFIX}${identity.managerId}.${generation}.${digest}` as McpToolBinding;
}

export function parseMcpToolBinding(binding: unknown): McpParsedToolBinding | undefined {
  if (
    typeof binding !== 'string' ||
    binding.length > MAX_MCP_TOOL_BINDING_CHARS ||
    !binding.startsWith(MCP_TOOL_BINDING_PREFIX)
  ) {
    return undefined;
  }
  const match = /^mcpb1\.([A-Za-z0-9_-]{22})\.([1-9a-z][0-9a-z]*)\.([A-Za-z0-9_-]{43})$/u.exec(
    binding,
  );
  if (!match) return undefined;
  const connectionGeneration = Number.parseInt(match[2], 36);
  if (
    !Number.isSafeInteger(connectionGeneration) ||
    connectionGeneration <= 0 ||
    connectionGeneration.toString(36) !== match[2]
  ) {
    return undefined;
  }
  return { managerId: match[1], connectionGeneration };
}

function isValidIdentity(identity: McpToolBindingIdentity): boolean {
  return (
    typeof identity.managerId === 'string' &&
    /^[A-Za-z0-9_-]{22}$/u.test(identity.managerId) &&
    Number.isSafeInteger(identity.connectionGeneration) &&
    identity.connectionGeneration > 0 &&
    typeof identity.serverId === 'string' &&
    typeof identity.toolName === 'string' &&
    typeof identity.definitionFingerprint === 'string' &&
    /^[A-Za-z0-9_-]{43}$/u.test(identity.definitionFingerprint)
  );
}
