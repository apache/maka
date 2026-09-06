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

import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  acquireFileLifetimeOwner,
  type FileLifetimeOwner,
} from '@maka/storage/file-lifetime-owner';
import { createRuntimeHostPeerClient, type RuntimeHostPeerClient } from '../client/peer-client.js';
import { RuntimeHostPermanentReconnectError } from '../client/reconnect-lifecycle.js';
import {
  openPeerReachabilityPublisher,
  PeerReachabilityPostCommitError,
  type PeerReachabilityPublisher,
} from './publisher.js';

const REACHABILITY_WATCH_TIMEOUT_MS = 60_000;
const REACHABILITY_RETRY_INTERVAL_MS = 5_000;

export interface RuntimeHostPeerEndpointOwner {
  readonly client: RuntimeHostPeerClient;
  readonly reachability: PeerReachabilityPublisher;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

export async function openRuntimeHostPeerEndpointOwner(input: {
  readonly nativePath: string;
  readonly keyPath: string;
  readonly expectedPeerId?: string;
  readonly dataRoot: string;
  readonly listenAddresses?: readonly string[];
  readonly coordinationRelays?: readonly string[];
  readonly automaticRelayDiscovery?: boolean;
  readonly webRtcStunUrls?: readonly string[];
  readonly onBackgroundReachabilityError?: (error: unknown) => void;
}): Promise<RuntimeHostPeerEndpointOwner> {
  await mkdir(input.dataRoot, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(input.dataRoot, 0o700);
  const rootOwner = await acquireFileLifetimeOwner(join(input.dataRoot, 'peer-endpoint.owner'));
  let client: RuntimeHostPeerClient | undefined;
  let reachability: PeerReachabilityPublisher | undefined;
  try {
    client = createRuntimeHostPeerClient({
      nativePath: input.nativePath,
      keyPath: input.keyPath,
      relayAnchorPath: join(input.dataRoot, 'relay-anchors.json'),
      ...(input.expectedPeerId ? { expectedPeerId: input.expectedPeerId } : {}),
      ...(input.listenAddresses ? { listenAddresses: input.listenAddresses } : {}),
      ...(input.coordinationRelays ? { coordinationRelays: input.coordinationRelays } : {}),
      ...(input.automaticRelayDiscovery === undefined
        ? {}
        : { automaticRelayDiscovery: input.automaticRelayDiscovery }),
      ...(input.webRtcStunUrls === undefined ? {} : { webRtcStunUrls: input.webRtcStunUrls }),
    });
    const peerId = client.identity().peerId;
    reachability = await openPeerReachabilityPublisher({
      dataRoot: join(input.dataRoot, peerId),
      peer: client,
    });
  } catch (error) {
    await reachability?.close().catch(() => undefined);
    await client?.close().catch(() => undefined);
    await rootOwner.close().catch(() => undefined);
    throw error;
  }
  let closeTask: Promise<void> | undefined;
  const ownedClient = client;
  const ownedReachability = reachability;
  const lifetime = new AbortController();
  const maintenance = maintainReachability(
    ownedClient,
    ownedReachability,
    lifetime.signal,
    input.onBackgroundReachabilityError,
  );
  void maintenance.catch(() => undefined);
  return Object.freeze({
    client: ownedClient,
    reachability: ownedReachability,
    closed: maintenance,
    close: () => {
      lifetime.abort();
      closeTask ??= closeEndpointOwner(ownedClient, ownedReachability, rootOwner, maintenance);
      return closeTask;
    },
  });
}

async function closeEndpointOwner(
  client: RuntimeHostPeerClient,
  reachability: PeerReachabilityPublisher,
  rootOwner: FileLifetimeOwner,
  maintenance: Promise<void>,
): Promise<void> {
  const errors: unknown[] = [];
  await client.close().catch((error: unknown) => errors.push(error));
  await maintenance.catch((error: unknown) => errors.push(error));
  await reachability.close().catch((error: unknown) => errors.push(error));
  await rootOwner.close().catch((error: unknown) => errors.push(error));
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Unable to close Runtime Host peer endpoint owner');
  }
}

async function maintainReachability(
  client: RuntimeHostPeerClient,
  publisher: PeerReachabilityPublisher,
  signal: AbortSignal,
  onError: ((error: unknown) => void) | undefined,
): Promise<void> {
  let generation = client.reachability().generation;
  while (!signal.aborted) {
    try {
      await publisher.refresh();
      generation = await client.watchReachability(generation, REACHABILITY_WATCH_TIMEOUT_MS);
    } catch (error) {
      if (signal.aborted) return;
      if (
        error instanceof PeerReachabilityPostCommitError ||
        error instanceof RuntimeHostPermanentReconnectError
      ) {
        throw error;
      }
      try {
        onError?.(error);
      } catch {
        // A diagnostic observer cannot control the endpoint lifetime.
      }
      try {
        await delay(REACHABILITY_RETRY_INTERVAL_MS, undefined, { signal });
      } catch {
        if (signal.aborted) return;
      }
    }
  }
}
