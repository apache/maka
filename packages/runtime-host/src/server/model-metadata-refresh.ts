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

import { bundledModelMetadata, installRefreshedModelMetadata } from '@maka/core/model-metadata';
import { fetchModelsDevProjection } from '@maka/core/models-dev-refresh';
import { redactSecrets } from '@maka/core/redaction';
import {
  createProxiedFetchTransport,
  type ProxiedFetchProxy,
  type ProxiedFetchTransport,
} from '@maka/runtime/network/scoped-fetch-transport';
import type { RuntimePolicyOperationCoordinator } from '@maka/storage/runtime-policy-stores';
import { toRuntimePolicyProxy } from './runtime-policy-proxy.js';

const MODELS_DEV_FETCH_TIMEOUT_MS = 10_000;
/** A normal refresh retires hundreds of paths; the count is the signal, the names are a sample. */
const LOGGED_REMOVAL_SAMPLE = 20;

export interface HostModelMetadataRefreshInput {
  readonly policy: Pick<RuntimePolicyOperationCoordinator, 'resolveHostOutboundExecution'>;
  /** Announce the swap so attached clients re-read the connection catalog. */
  readonly publish: () => void;
  readonly createFetchTransport?: (proxy: ProxiedFetchProxy | null) => ProxiedFetchTransport;
  readonly timeoutMs?: number;
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
 * Every failure — offline, timeout, an oversized body, an upstream shape the
 * projection refuses — keeps the snapshot compiled into this build. There is
 * no partial install: a catalog that does not project whole is not a catalog.
 *
 * A refresh that lands is taken whole, including what upstream stopped
 * carrying: the snapshot is not a second opinion about a model upstream still
 * publishes. Where the generator refuses a shrinking refresh until a human
 * acknowledges it, the Host records the removals and adopts them — nothing
 * here is committed or redistributed, and the next process start asks again.
 *
 * The attempt is made once, at startup. A Host started in privacy mode does
 * not refresh at all, and leaving privacy mode later does not start one.
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

function removalSummary(paths: readonly string[]): string {
  const sample = paths.slice(0, LOGGED_REMOVAL_SAMPLE).join(', ');
  const rest = paths.length - LOGGED_REMOVAL_SAMPLE;
  return `models.dev no longer carries ${paths.length} path(s) the bundled snapshot described; adopting upstream: ${sample}${rest > 0 ? ` and ${rest} more` : ''}`;
}

async function run(input: HostModelMetadataRefreshInput, signal: AbortSignal): Promise<void> {
  const admission = await input.policy.resolveHostOutboundExecution();
  if (admission.kind !== 'ready') {
    console.error(
      admission.kind === 'privacy_mode'
        ? '[runtime-host] models.dev catalog refresh skipped: privacy mode is active'
        : '[runtime-host] models.dev catalog refresh skipped: the network proxy credential is not configured',
    );
    return;
  }
  signal.throwIfAborted();
  const transport = (input.createFetchTransport ?? createProxiedFetchTransport)(
    toRuntimePolicyProxy(admission.networkProxy, admission.secretMaterial.networkProxy?.secret),
  );
  const timeout = AbortSignal.timeout(input.timeoutMs ?? MODELS_DEV_FETCH_TIMEOUT_MS);
  try {
    const metadata = await fetchModelsDevProjection({
      fetch: transport.fetch,
      signal: AbortSignal.any([signal, timeout]),
      previous: bundledModelMetadata,
      onRemovals: (paths) => console.error(`[runtime-host] ${removalSummary(paths)}`),
    });
    signal.throwIfAborted();
    // Install before publishing: a client that re-reads on the frame must find
    // the refreshed catalog, not the one it already had.
    installRefreshedModelMetadata(metadata);
    input.publish();
  } finally {
    await transport.close();
  }
}
