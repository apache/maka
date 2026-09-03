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
import type { McpBoundTool, McpToolBinding } from '@maka/core/mcp';
import type { McpClientManager } from '@maka/mcp';
import type { ClientCapabilityProvider } from '@maka/runtime-host/client';
import {
  CLIENT_CAPABILITY_MAX_TOOLS,
  CLIENT_CAPABILITY_MAX_TOOLS_PER_OFFER,
  decodeClientCapabilityReplaceInput,
  type ClientCapabilityCallResult,
  type ClientCapabilityOffer,
} from '@maka/runtime-host/protocol';
import type { McpCallResult, McpToolDescriptor } from '@maka/core/mcp';

const CAPABILITY_VERSION = '0';

export function createMcpCapabilityProvider(
  manager: Pick<McpClientManager, 'toolSnapshot' | 'callTool'>,
): ClientCapabilityProvider | undefined {
  const toolSnapshot = manager.toolSnapshot();
  const tools = [...toolSnapshot.tools].sort(
    (left, right) =>
      left.descriptor.serverId.localeCompare(right.descriptor.serverId) ||
      left.descriptor.name.localeCompare(right.descriptor.name),
  );
  const toolCount = tools.length;
  if (toolCount === 0) return undefined;
  if (toolCount > CLIENT_CAPABILITY_MAX_TOOLS) {
    throw new Error(
      `MCP capability provider exposes ${toolCount} tools; the limit is ${CLIENT_CAPABILITY_MAX_TOOLS}`,
    );
  }

  const projectedIdentities = new Set<string>();
  const projected: Array<{
    readonly source: McpBoundTool;
    readonly descriptor: ReturnType<typeof projectMcpTool>;
  }> = [];
  for (const source of tools) {
    const descriptor = projectMcpTool(
      source.descriptor,
      capabilityEntityId(source.descriptor.serverId),
    );
    const identity = `${descriptor.serverId}\0${descriptor.name}`;
    if (projectedIdentities.has(identity)) {
      throw new Error('MCP tools collide after Client Capability identity normalization');
    }
    projectedIdentities.add(identity);
    projected.push({ source, descriptor });
  }

  const bindings = new Map<string, McpToolBinding>();
  const offers: ClientCapabilityOffer[] = [];
  for (let offset = 0; offset < projected.length; offset += CLIENT_CAPABILITY_MAX_TOOLS_PER_OFFER) {
    const chunk = projected.slice(offset, offset + CLIENT_CAPABILITY_MAX_TOOLS_PER_OFFER);
    const offerId = mcpOfferId(chunk, offset / CLIENT_CAPABILITY_MAX_TOOLS_PER_OFFER);
    const servers = new Set(chunk.map(({ source }) => source.descriptor.serverId));
    offers.push({
      offerId,
      version: CAPABILITY_VERSION,
      affinity: 'session',
      hostPathAccess: 'none',
      label:
        servers.size === 1
          ? `MCP: ${chunk[0]?.source.descriptor.serverId ?? 'tools'}`.slice(0, 128)
          : `MCP tools (${servers.size} servers)`,
      description: 'Use tools provided by connected MCP servers.',
      tools: chunk.map(({ descriptor }) => descriptor),
    });
    for (const { source, descriptor } of chunk) {
      bindings.set(
        capabilityBindingKey(offerId, descriptor.serverId, descriptor.name),
        source.binding,
      );
    }
  }
  const canonical = decodeClientCapabilityReplaceInput({
    registrationId: '00000000-0000-4000-8000-000000000000',
    offers,
  });

  return {
    offers: () => canonical.offers,
    call: async (frame, options) => {
      const binding = bindings.get(
        capabilityBindingKey(frame.offerId, frame.serverId, frame.toolName),
      );
      if (!binding) throw new Error('MCP capability is not part of the published snapshot');
      await options.accept({ kind: 'none' });
      return projectMcpResult(
        await manager.callTool(binding, frame.arguments, { signal: options.signal }),
      );
    },
  };
}

function projectMcpTool(tool: McpToolDescriptor, wireServerId: string) {
  return {
    serverId: wireServerId,
    name: capabilityEntityId(tool.name),
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: structuredClone(tool.inputSchema),
    ...(tool.annotations ? { annotations: { ...tool.annotations } } : {}),
  };
}

function capabilityEntityId(value: string): string {
  if (/^[A-Za-z0-9_-]{1,128}$/u.test(value)) return value;
  const label = value.replace(/[^A-Za-z0-9_-]+/gu, '_').slice(0, 103) || 'mcp';
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 24);
  return `${label}_${digest}`;
}

function projectMcpResult(result: McpCallResult): ClientCapabilityCallResult {
  return {
    content: result.content.map((block) => structuredClone(block)),
    ...(result.structuredContent === undefined
      ? {}
      : { structuredContent: structuredClone(result.structuredContent) }),
  };
}

function mcpOfferId(tools: readonly { readonly source: McpBoundTool }[], chunk: number): string {
  const hash = createHash('sha256').update(`mcp-capability-offer-v0\0${chunk}`);
  for (const { source } of tools)
    hash
      .update('\0')
      .update(source.descriptor.serverId)
      .update('\0')
      .update(source.descriptor.name);
  return `mcp_${hash.digest('hex').slice(0, 24)}_${chunk}`;
}

function capabilityBindingKey(offerId: string, serverId: string, toolName: string): string {
  return `${offerId}\0${serverId}\0${toolName}`;
}
