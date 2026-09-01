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

import { redactSecrets } from '@maka/core/redaction';
import { installRefreshedModelMetadata } from '@maka/core/model-metadata';
import {
  MODELS_DEV_SOURCE_URL,
  projectModelsDevMetadata,
  selectModelsDevCatalog,
} from '@maka/core/models-dev-projection';
import {
  createProxiedFetchTransport,
  type ProxiedFetchProxy,
  type ProxiedFetchTransport,
} from '@maka/runtime/network/scoped-fetch-transport';
import type { RuntimePolicyOperationCoordinator } from '@maka/storage/runtime-policy-stores';
import { toRuntimePolicyProxy } from './runtime-policy-proxy.js';

/** models.dev is a few megabytes of JSON; well past that it is not the catalog. */
const MODELS_DEV_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;
const MODELS_DEV_FETCH_TIMEOUT_MS = 10_000;

export interface HostModelMetadataRefreshInput {
  readonly policy: Pick<RuntimePolicyOperationCoordinator, 'resolveHostOutboundExecution'>;
  /** Announce the swap so attached clients re-read the connection catalog. */
  readonly publish: () => void;
  readonly createFetchTransport?: (proxy: ProxiedFetchProxy | null) => ProxiedFetchTransport;
  readonly timeoutMs?: number;
  readonly onSkipped?: (reason: 'privacy_mode' | 'credential_not_configured') => void;
}

export interface HostModelMetadataRefresh {
  /** Resolves when the one refresh attempt has finished, however it ended. */
  readonly settled: Promise<void>;
  close(): Promise<void>;
}

/**
 * Fetch the models.dev catalog once and make it this Host's model metadata.
 *
 * The Host is the only process that does this. Clients read Host-resolved
 * catalog entries, so a Host on a stale build still describes every model the
 * way the live catalog does.
 *
 * Every failure — offline, timeout, an upstream shape the projection refuses —
 * keeps the snapshot compiled into this build. There is no partial install: a
 * catalog that does not project whole is not a catalog.
 */
export function startHostModelMetadataRefresh(
  input: HostModelMetadataRefreshInput,
): HostModelMetadataRefresh {
  const abort = new AbortController();
  const settled = run(input, abort.signal).catch((error: unknown) => {
    if (abort.signal.aborted) return;
    // The message itself, not a generalized category: the projection names the
    // provider and model it refused, and that is the whole diagnostic here.
    console.error(
      `[runtime-host] models.dev catalog refresh failed, keeping the bundled snapshot: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
    );
  });
  return {
    settled,
    close: async () => {
      abort.abort(new Error('Runtime Host model metadata refresh closed'));
      await settled;
    },
  };
}

async function run(input: HostModelMetadataRefreshInput, signal: AbortSignal): Promise<void> {
  const admission = await input.policy.resolveHostOutboundExecution();
  if (admission.kind !== 'ready') {
    input.onSkipped?.(admission.kind);
    return;
  }
  signal.throwIfAborted();
  const transport = (input.createFetchTransport ?? createProxiedFetchTransport)(
    toRuntimePolicyProxy(admission.networkProxy, admission.secretMaterial.networkProxy?.secret),
  );
  const timeout = AbortSignal.timeout(input.timeoutMs ?? MODELS_DEV_FETCH_TIMEOUT_MS);
  try {
    const response = await transport.fetch(MODELS_DEV_SOURCE_URL, {
      signal: AbortSignal.any([signal, timeout]),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`models.dev responded ${response.status}`);
    }
    const body = await response.text();
    if (body.length > MODELS_DEV_RESPONSE_MAX_BYTES) {
      throw new Error('models.dev response exceeded the accepted size');
    }
    const metadata = projectModelsDevMetadata(selectModelsDevCatalog(JSON.parse(body)));
    signal.throwIfAborted();
    // Install before publishing: a client that re-reads on the frame must find
    // the refreshed catalog, not the one it already had.
    installRefreshedModelMetadata(metadata);
    input.publish();
  } finally {
    await transport.close();
  }
}
