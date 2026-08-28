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
import { openPeerMeshNode, type PeerMeshNode } from './node.js';

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
}): Promise<RuntimeHostPeerMeshOwner> {
  let mesh: PeerMeshNode | undefined;
  const client = createRuntimeHostPeerClient({
    nativePath: input.nativePath,
    keyPath: input.keyPath,
    ...(input.expectedPeerId ? { expectedPeerId: input.expectedPeerId } : {}),
    ...(input.listenAddresses ? { listenAddresses: input.listenAddresses } : {}),
    ...(input.coordinationRelays ? { coordinationRelays: input.coordinationRelays } : {}),
    routeResolver: { resolveRoutes: (peerId) => mesh?.resolveRoutes(peerId) },
  });
  try {
    mesh = await openPeerMeshNode({ dataRoot: input.dataRoot, peer: client });
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
  const serving = mesh.serve();
  let closeTask: Promise<void> | undefined;
  const close = () => {
    closeTask ??= closeOwner(mesh!, client, serving);
    return closeTask;
  };
  const closed = serving.then(close, close);
  void closed.catch(() => undefined);
  return Object.freeze({
    client,
    mesh,
    closed,
    close,
  });
}

async function closeOwner(
  mesh: PeerMeshNode,
  client: RuntimeHostPeerClient,
  serving: Promise<void>,
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
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Unable to close peer Mesh owner');
}
