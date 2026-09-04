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

import { join } from 'node:path';
import type { RuntimeHostPeerEndpointOwner } from '../peer-reachability/index.js';
import { openPeerMeshNode, type PeerMeshNode } from './node.js';
import { migrateLegacyPeerMeshState } from './store.js';

export interface RuntimeHostPeerMeshComponent {
  readonly mesh: PeerMeshNode;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

interface RuntimeHostPeerMeshComponentInput {
  readonly dataRoot: string;
  readonly endpoint: RuntimeHostPeerEndpointOwner;
  readonly endpointKind: 'client' | 'host';
  readonly onBackgroundReconcileError?: (error: unknown) => void;
}

export async function openRuntimeHostPeerMeshComponent(
  input: RuntimeHostPeerMeshComponentInput,
): Promise<RuntimeHostPeerMeshComponent> {
  const peerId = input.endpoint.client.identity().peerId;
  await migrateLegacyPeerMeshState(input.dataRoot, peerId);
  const mesh = await openPeerMeshNode({
    dataRoot: join(input.dataRoot, peerId),
    peer: input.endpoint.client,
    reachability: input.endpoint.reachability,
    endpointKind: input.endpointKind,
    ...(input.onBackgroundReconcileError
      ? { onBackgroundReconcileError: input.onBackgroundReconcileError }
      : {}),
  });
  let detachResolver: (() => void) | undefined;
  let serving: Promise<void>;
  try {
    detachResolver = input.endpoint.client.attachRouteResolver(mesh);
    serving = mesh.serve();
  } catch (error) {
    detachResolver?.();
    await mesh.close().catch(() => undefined);
    throw error;
  }
  let closeTask: Promise<void> | undefined;
  const close = () => {
    closeTask ??= closeMesh(mesh, serving, detachResolver!);
    return closeTask;
  };
  const closed = serving.then(
    () =>
      closeTask ??
      stopUnexpectedMesh(mesh, detachResolver!, new Error('Peer Mesh stopped unexpectedly')),
    (error: unknown) => closeTask ?? stopUnexpectedMesh(mesh, detachResolver!, error),
  );
  void closed.catch(() => undefined);
  return Object.freeze({ mesh, closed, close });
}

async function stopUnexpectedMesh(
  mesh: PeerMeshNode,
  detachResolver: () => void,
  error: unknown,
): Promise<never> {
  detachResolver();
  try {
    await mesh.close();
  } catch (closeError) {
    throw new AggregateError([error, closeError], 'Peer Mesh failed to stop');
  }
  throw error;
}

async function closeMesh(
  mesh: PeerMeshNode,
  serving: Promise<void>,
  detachResolver: () => void,
): Promise<void> {
  const errors: unknown[] = [];
  detachResolver();
  await mesh.close().catch((error: unknown) => errors.push(error));
  await serving.catch((error: unknown) => errors.push(error));
  throwCollected(errors, 'Unable to close Peer Mesh');
}

function throwCollected(errors: readonly unknown[], message: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}
