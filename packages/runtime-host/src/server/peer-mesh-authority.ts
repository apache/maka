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

import type { PeerMeshNode, PeerMeshStatus } from '../peer-mesh/node.js';
import { PeerMeshPersistenceError, PeerMeshPostCommitError } from '../peer-mesh/store.js';
import type { PeerMeshProjection, PeerMeshQueryResult } from '../protocol/peer-mesh.js';
import type { OperationOutcome } from '../protocol/operations.js';
import type { OperationHandlerMap } from './operation-dispatcher.js';

export type PeerMeshOperationHandlers = Pick<
  OperationHandlerMap,
  | 'peer.mesh.query'
  | 'peer.mesh.create'
  | 'peer.mesh.invite'
  | 'peer.mesh.join'
  | 'peer.mesh.remove'
  | 'peer.mesh.leave'
  | 'peer.mesh.close'
  | 'peer.mesh.reconcile'
  | 'peer.mesh.transit.set'
  | 'peer.mesh.display-name.set'
  | 'peer.mesh.rename'
>;

export function createPeerMeshOperationHandlers(
  mesh: PeerMeshNode | undefined,
  options: { readonly requestDrain?: () => void } = {},
): PeerMeshOperationHandlers {
  const query = (): PeerMeshQueryResult => projectPeerMeshQuery(mesh);
  const unavailable = <K extends keyof PeerMeshOperationHandlers>(): OperationOutcome<K> =>
    ({
      ok: false,
      error: {
        code: 'operation_unavailable',
        message: 'Direct peer is not enabled for this Runtime Host',
      },
    }) as OperationOutcome<K>;
  const mutate = async <K extends keyof PeerMeshOperationHandlers>(
    operation: () => Promise<OperationOutcome<K>>,
  ): Promise<OperationOutcome<K>> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof PeerMeshPostCommitError) {
        options.requestDrain?.();
        return {
          ok: false,
          error: {
            code: 'commit_outcome_unknown',
            message: 'Peer Mesh changed, but its durable commit could not be confirmed',
          },
        } as OperationOutcome<K>;
      }
      if (error instanceof PeerMeshPersistenceError) {
        return {
          ok: false,
          error: {
            code: 'persistence_failed',
            message: 'Peer Mesh state could not be saved',
          },
        } as OperationOutcome<K>;
      }
      return {
        ok: false,
        error: {
          code: 'invalid_request',
          message: error instanceof Error ? error.message : 'Peer Mesh operation failed',
        },
      } as OperationOutcome<K>;
    }
  };

  return {
    'peer.mesh.query': async () => ({ ok: true, result: query() }),
    'peer.mesh.create': async () => {
      if (!mesh) return unavailable();
      return mutate(async () => {
        await mesh.create();
        return { ok: true, result: query() };
      });
    },
    'peer.mesh.invite': async (input) => {
      if (!mesh) return unavailable();
      return mutate(async () => ({
        ok: true,
        result: {
          invitation: await mesh.invite(input.meshId),
          snapshot: query(),
        },
      }));
    },
    'peer.mesh.join': async (input) => {
      if (!mesh) return unavailable();
      return mutate(async () => {
        await mesh.join(input.invitation);
        return { ok: true, result: query() };
      });
    },
    'peer.mesh.remove': async (input) => {
      if (!mesh) return unavailable();
      return mutate(async () => {
        await mesh.remove(input.meshId, input.peerId);
        return { ok: true, result: query() };
      });
    },
    'peer.mesh.leave': async (input) => {
      if (!mesh) return unavailable();
      return mutate(async () => {
        await mesh.leave(input.meshId);
        return { ok: true, result: query() };
      });
    },
    'peer.mesh.close': async (input) => {
      if (!mesh) return unavailable();
      return mutate(async () => {
        await mesh.closeMesh(input.meshId);
        return { ok: true, result: query() };
      });
    },
    'peer.mesh.reconcile': async () => {
      if (!mesh) return unavailable();
      return mutate(async () => {
        await mesh.reconcile();
        return { ok: true, result: query() };
      });
    },
    'peer.mesh.transit.set': async (input) => {
      if (!mesh) return unavailable();
      return mutate(async () => {
        await mesh.setTransitMesh(input.meshId);
        return { ok: true, result: query() };
      });
    },
    'peer.mesh.display-name.set': async (input) => {
      if (!mesh) return unavailable();
      return mutate(async () => {
        await mesh.setDisplayName(input.displayName);
        return { ok: true, result: query() };
      });
    },
    'peer.mesh.rename': async (input) => {
      if (!mesh) return unavailable();
      return mutate(async () => {
        await mesh.setMeshDisplayName(input.meshId, input.displayName);
        return { ok: true, result: query() };
      });
    },
  };
}

export function projectPeerMeshStatus(status: PeerMeshStatus): PeerMeshProjection {
  return Object.freeze({
    meshId: status.roster.roster.meshId,
    ...(status.roster.roster.displayName ? { displayName: status.roster.roster.displayName } : {}),
    role: status.role,
    authorityPeerId: status.authority.peerId,
    revision: status.roster.roster.revision,
    closed: status.roster.roster.closed,
    members: Object.freeze(status.memberRoutes.map((member) => Object.freeze({ ...member }))),
    pendingInvitationCount: status.pendingInvitationCount,
  });
}

export function projectPeerMeshQuery(mesh: PeerMeshNode | undefined): PeerMeshQueryResult {
  if (!mesh) return { available: false, meshes: [] };
  const displayName = mesh.displayName();
  return Object.freeze({
    available: true,
    localPeerId: mesh.localPeerId(),
    ...(displayName ? { localDisplayName: displayName } : {}),
    meshes: Object.freeze(mesh.status().map(projectPeerMeshStatus)),
    transit: projectTransitSnapshot(mesh.transitMeshId(), mesh.transitSnapshot()),
  });
}

function projectTransitSnapshot(
  meshId: string | null,
  snapshot: ReturnType<PeerMeshNode['transitSnapshot']>,
) {
  return Object.freeze({
    meshId,
    allowedMemberCount: snapshot.allowedPeerCount,
    activeReservationCount: snapshot.activeReservationCount,
    activeCircuitCount: snapshot.activeCircuitCount,
    maxReservationCount: snapshot.maxReservationCount,
    maxCircuitCount: snapshot.maxCircuitCount,
    maxCircuitsPerPeer: snapshot.maxCircuitsPerPeer,
    maxCircuitDurationSeconds: snapshot.maxCircuitDurationSeconds,
    maxCircuitBytes: snapshot.maxCircuitBytes,
  });
}
