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
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type {
  McpBoundTool,
  McpCallResult,
  McpToolBinding,
  McpToolDescriptor,
} from '@maka/core/mcp';
import { createCredentialMcpOAuthStorage, McpClientManager } from '@maka/mcp';
import { createFileCredentialStore, normalizeMcpConfig } from '@maka/storage';
import {
  connectRemoteRuntimeHost,
  loadOrCreateRuntimeHostClientInstanceId,
  remoteRuntimeHostUnavailableError,
  RuntimeHostPermanentReconnectError,
  startRuntimeHostCapabilityProviderService,
  type ClientCapabilityProvider,
  type RuntimeHostConnection,
} from '@maka/runtime-host/client';
import {
  CLIENT_CAPABILITY_MAX_TOOLS,
  CLIENT_CAPABILITY_MAX_TOOLS_PER_OFFER,
  decodeClientCapabilityReplaceInput,
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type ClientCapabilityCallResult,
  type ClientCapabilityOffer,
} from '@maka/runtime-host/protocol';
import { runRuntimeHostProcessLifecycle } from '@maka/runtime-host/server';

const DEFAULT_CREDENTIAL_ENV = 'MAKA_RUNTIME_HOST_ACCESS_CREDENTIAL';
const CAPABILITY_VERSION = '0';
const MAX_MCP_CONFIG_BYTES = 1_048_576;
const MCP_RECONNECT_INTERVAL_MS = 5_000;

export interface RuntimeHostCapabilityProviderCliOptions {
  readonly url: string;
  readonly mcpConfigPath: string;
  readonly expectedRootId: string;
  readonly credentialEnv?: string;
  readonly clientIdentityPath?: string;
  readonly defaultClientIdentityRoot?: string;
}

export async function runRuntimeHostCapabilityProviderCli(
  options: RuntimeHostCapabilityProviderCliOptions,
): Promise<number> {
  const configPath = resolve(options.mcpConfigPath);
  const identityPath = resolve(
    options.clientIdentityPath ??
      defaultProviderClientIdentityPath(options.url, configPath, options.defaultClientIdentityRoot),
  );
  const credentialEnv = options.credentialEnv ?? DEFAULT_CREDENTIAL_ENV;
  const credential = process.env[credentialEnv];
  if (!credential)
    throw new Error(`Runtime Host access credential is missing from ${credentialEnv}`);

  const configText = await readFile(configPath, 'utf8');
  if (Buffer.byteLength(configText, 'utf8') > MAX_MCP_CONFIG_BYTES) {
    throw new Error('MCP config exceeds 1 MiB');
  }
  const config = normalizeMcpConfig(JSON.parse(configText));
  const clientInstanceId = await loadOrCreateRuntimeHostClientInstanceId(identityPath);
  const manager = new McpClientManager({
    clientName: 'maka-capability-provider',
    excludedStdioEnvironmentKeys: [credentialEnv],
    // Same credential store Desktop writes (credentials.json beside the
    // config): without it this process is credential-blind — every remote
    // OAuth server 401s forever while forgetServerCredentials reports
    // success and erases nothing.
    oauthStorage: createCredentialMcpOAuthStorage(createFileCredentialStore(dirname(configPath))),
  });
  await manager.sync(config);

  let service: Awaited<ReturnType<typeof startRuntimeHostCapabilityProviderService>> | undefined;
  let publishedRevision = manager.toolSnapshot().revision;
  const disposeChanges = manager.onChange(() => {
    const revision = manager.toolSnapshot().revision;
    if (revision === publishedRevision) return;
    publishedRevision = revision;
    void service?.refresh().catch(reportRefreshFailure);
  });
  const reconnectTimer = setInterval(() => {
    for (const status of manager.statuses()) {
      if (status.state !== 'disconnected' && status.state !== 'error') continue;
      void manager.connect(status.serverId).catch(() => undefined);
    }
  }, MCP_RECONNECT_INTERVAL_MS);
  reconnectTimer.unref();
  try {
    service = await startRuntimeHostCapabilityProviderService({
      connect: (signal) =>
        connectRemoteCapabilityProvider({
          url: options.url,
          credential,
          clientInstanceId,
          signal,
          expectedRootId: options.expectedRootId,
        }),
      createProvider: () => createMcpCapabilityProvider(manager),
      onReconnectError: (error) => {
        process.stderr.write(
          `Runtime Host capability provider reconnect failed: ${error.message}\n`,
        );
      },
      onPublicationError: reportRefreshFailure,
      onFatalError: (error) => {
        process.exitCode = 1;
        process.stderr.write(`Runtime Host capability provider stopped: ${error.message}\n`);
      },
    });
    await runRuntimeHostProcessLifecycle(service, {
      onReady: () => {
        process.stdout.write(
          `Runtime Host capability provider is connected (${manager.toolSnapshot().tools.length} MCP tools)\n`,
        );
      },
    });
    return 0;
  } finally {
    clearInterval(reconnectTimer);
    disposeChanges();
    await service?.close().catch(() => undefined);
    await manager.close();
  }
}

function defaultProviderClientIdentityPath(
  url: string,
  configPath: string,
  defaultClientIdentityRoot?: string,
): string {
  const identity = createHash('sha256')
    .update(`runtime-host-capability-provider\0${url}\0${configPath}`)
    .digest('hex')
    .slice(0, 24);
  const identityRoot =
    defaultClientIdentityRoot ?? join(homedir(), '.maka', 'runtime-host-capability-providers');
  return join(identityRoot, `${identity}.json`);
}

async function connectRemoteCapabilityProvider(input: {
  readonly url: string;
  readonly credential: string;
  readonly clientInstanceId: string;
  readonly expectedRootId: string;
  readonly signal: AbortSignal;
}): Promise<RuntimeHostConnection> {
  input.signal.throwIfAborted();
  const connected = await connectRemoteRuntimeHost({
    url: input.url,
    credential: input.credential,
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
    clientInstanceId: input.clientInstanceId,
    expectedRootId: input.expectedRootId,
  });
  if (input.signal.aborted) {
    if (connected.kind === 'connected') await connected.connection.close();
    input.signal.throwIfAborted();
  }
  if (connected.kind === 'connected') return connected.connection;
  if (connected.kind === 'incompatible') {
    if (connected.handshake.compatibilityEpoch < RUNTIME_HOST_COMPATIBILITY_EPOCH) {
      throw new RuntimeHostPermanentReconnectError(
        'The remote Runtime Host is older than this capability provider. Upgrade or restart the Runtime Host, then reconnect.',
      );
    }
    throw new RuntimeHostPermanentReconnectError(
      `Runtime Host protocol is incompatible (Host ${connected.handshake.protocolMin}-${connected.handshake.protocolMax})`,
    );
  }
  if (connected.kind === 'unavailable') {
    throw remoteRuntimeHostUnavailableError('Runtime Host', connected.reason);
  }
  throw new Error('Runtime Host is draining');
}

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
      await options.accept();
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

function reportRefreshFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Runtime Host capability publication refresh failed: ${message}\n`);
}
