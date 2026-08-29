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

import { createRuntimeHostPeerClient, type RuntimeHostPeerClient } from '../client/peer-client.js';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  acquireFileLifetimeOwner,
  type FileLifetimeOwner,
} from '@maka/storage/file-lifetime-owner';
import { openPeerMeshNode, type PeerMeshNode } from './node.js';
import { migrateLegacyPeerMeshState } from './store.js';

export interface RuntimeHostPeerMeshOwner {
  readonly client: RuntimeHostPeerClient;
  readonly mesh: PeerMeshNode;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

export async function openRuntimeHostPeerMeshOwner(input: {
  readonly nativePath: string;
  readonly keyPath: string;
  readonly expectedPeerId?: string;
  readonly dataRoot: string;
  readonly listenAddresses?: readonly string[];
  readonly coordinationRelays?: readonly string[];
  readonly automaticRelayDiscovery?: boolean;
}): Promise<RuntimeHostPeerMeshOwner> {
  let mesh: PeerMeshNode | undefined;
  let resolverMesh: PeerMeshNode | undefined;
  await mkdir(input.dataRoot, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(input.dataRoot, 0o700);
  const rootOwner = await acquireFileLifetimeOwner(join(input.dataRoot, 'peer-mesh.owner'));
  let client: RuntimeHostPeerClient;
  try {
    client = createRuntimeHostPeerClient({
      nativePath: input.nativePath,
      keyPath: input.keyPath,
      ...(input.expectedPeerId ? { expectedPeerId: input.expectedPeerId } : {}),
      ...(input.listenAddresses ? { listenAddresses: input.listenAddresses } : {}),
      ...(input.coordinationRelays ? { coordinationRelays: input.coordinationRelays } : {}),
      ...(input.automaticRelayDiscovery === undefined
        ? {}
        : { automaticRelayDiscovery: input.automaticRelayDiscovery }),
      routeResolver: {
        resolveRoutes: (peerId) => resolverMesh?.resolveRoutes(peerId),
      },
    });
  } catch (error) {
    await rootOwner.close().catch(() => undefined);
    throw error;
  }
  try {
    await migrateLegacyPeerMeshState(input.dataRoot, client.identity().peerId);
    mesh = await openPeerMeshNode({
      dataRoot: join(input.dataRoot, client.identity().peerId),
      peer: client,
    });
    resolverMesh = mesh;
  } catch (error) {
    await client.close().catch(() => undefined);
    await rootOwner.close().catch(() => undefined);
    throw error;
  }
  const serving = mesh.serve();
  let closeTask: Promise<void> | undefined;
  const close = () => {
    resolverMesh = undefined;
    closeTask ??= closeOwner(mesh!, client, serving, rootOwner);
    return closeTask;
  };
  const stopUnexpected = (error: unknown) => {
    resolverMesh = undefined;
    return stopUnexpectedOwner(mesh!, error);
  };
  const closed = serving.then(
    () =>
      closeTask ?? stopUnexpected(new Error('Runtime Host Peer Mesh owner stopped unexpectedly')),
    (error: unknown) => closeTask ?? stopUnexpected(error),
  );
  void closed.catch(() => undefined);
  return Object.freeze({
    client,
    mesh,
    closed,
    close,
  });
}

async function stopUnexpectedOwner(mesh: PeerMeshNode, error: unknown): Promise<never> {
  try {
    await mesh.close();
  } catch (closeError) {
    throw new AggregateError([error, closeError], 'Runtime Host Peer Mesh owner failed to stop');
  }
  throw error;
}

async function closeOwner(
  mesh: PeerMeshNode,
  client: RuntimeHostPeerClient,
  serving: Promise<void>,
  rootOwner: FileLifetimeOwner,
): Promise<void> {
  const errors: unknown[] = [];
  await mesh.close().catch((error: unknown) => {
    errors.push(error);
  });
  await serving.catch((error: unknown) => {
    errors.push(error);
  });
  await client.close().catch((error: unknown) => {
    errors.push(error);
  });
  await rootOwner.close().catch((error: unknown) => {
    errors.push(error);
  });
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Unable to close peer Mesh owner');
}
