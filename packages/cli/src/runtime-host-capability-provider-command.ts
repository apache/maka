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
import { createCredentialMcpOAuthStorage, McpClientManager } from '@maka/mcp';
import { createFileCredentialStore } from '@maka/storage/credential-store';
import { normalizeMcpConfig } from '@maka/storage/mcp-config-store';
import {
  connectRemoteRuntimeHost,
  loadOrCreateRuntimeHostClientInstanceId,
  remoteRuntimeHostUnavailableError,
  RuntimeHostPermanentReconnectError,
  startRuntimeHostCapabilityProviderService,
  type RuntimeHostConnection,
} from '@maka/runtime-host/client';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
} from '@maka/runtime-host/protocol';
import { runRuntimeHostProcessLifecycle } from '@maka/runtime-host/server';
import { createMcpCapabilityProvider } from './mcp-capability-provider.js';

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

export { createMcpCapabilityProvider } from './mcp-capability-provider.js';

function reportRefreshFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Runtime Host capability publication refresh failed: ${message}\n`);
}
