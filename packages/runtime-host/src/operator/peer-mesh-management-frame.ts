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

import { z } from 'zod';
import {
  decodePeerMeshInvitationResult,
  decodePeerMeshQueryResult,
  type PeerMeshInvitationResult,
  type PeerMeshQueryResult,
} from '../protocol/peer-mesh.js';

export const RUNTIME_HOST_PEER_MESH_MANAGEMENT_FRAME_PREFIX =
  'MAKA_RUNTIME_HOST_PEER_MESH_MANAGEMENT_V1 ';
export const RUNTIME_HOST_PEER_MESH_MANAGEMENT_FRAME_MAX_BYTES = 1024 * 1024;

const ACTION_SCHEMA = z.enum([
  'status',
  'create',
  'invite',
  'join',
  'remove',
  'leave',
  'close',
  'reconcile',
  'transit',
  'rename',
  'rename-mesh',
]);
const FRAME_SCHEMA = z.union([
  z.object({ kind: z.literal('input'), action: z.literal('join') }).strict(),
  z.object({ kind: z.literal('result'), action: ACTION_SCHEMA, result: z.unknown() }).strict(),
  z
    .object({
      kind: z.literal('error'),
      action: ACTION_SCHEMA,
      error: z
        .object({
          code: z.string().max(128),
          message: z.string().max(2 * 1024),
        })
        .strict(),
    })
    .strict(),
]);

export type RuntimeHostPeerMeshManagementAction =
  | 'status'
  | 'create'
  | 'invite'
  | 'join'
  | 'remove'
  | 'leave'
  | 'close'
  | 'reconcile'
  | 'transit'
  | 'rename'
  | 'rename-mesh';
export type RuntimeHostPeerMeshManagementFrame =
  | { readonly kind: 'input'; readonly action: 'join' }
  | {
      readonly kind: 'result';
      readonly action:
        | 'status'
        | 'create'
        | 'join'
        | 'remove'
        | 'leave'
        | 'close'
        | 'reconcile'
        | 'transit'
        | 'rename'
        | 'rename-mesh';
      readonly result: PeerMeshQueryResult;
    }
  | {
      readonly kind: 'result';
      readonly action: 'invite';
      readonly result: PeerMeshInvitationResult;
    }
  | {
      readonly kind: 'error';
      readonly action: RuntimeHostPeerMeshManagementAction;
      readonly error: { readonly code: string; readonly message: string };
    };

export function encodeRuntimeHostPeerMeshManagementFrame(
  frame: RuntimeHostPeerMeshManagementFrame,
): string {
  const encoded = Buffer.from(JSON.stringify(decodeFrame(frame)), 'utf8').toString('base64url');
  if (Buffer.byteLength(encoded, 'utf8') > RUNTIME_HOST_PEER_MESH_MANAGEMENT_FRAME_MAX_BYTES) {
    throw new RangeError('Runtime Host Peer Mesh management frame exceeds the size limit');
  }
  return `${RUNTIME_HOST_PEER_MESH_MANAGEMENT_FRAME_PREFIX}${encoded}\n`;
}

export function decodeRuntimeHostPeerMeshManagementFrame(
  line: string,
): RuntimeHostPeerMeshManagementFrame | undefined {
  const marker = line.indexOf(RUNTIME_HOST_PEER_MESH_MANAGEMENT_FRAME_PREFIX);
  if (marker < 0) return undefined;
  try {
    const encoded = line
      .slice(marker + RUNTIME_HOST_PEER_MESH_MANAGEMENT_FRAME_PREFIX.length)
      .trim();
    if (
      encoded.length === 0 ||
      Buffer.byteLength(encoded, 'utf8') > RUNTIME_HOST_PEER_MESH_MANAGEMENT_FRAME_MAX_BYTES
    ) {
      return undefined;
    }
    return decodeFrame(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
  } catch {
    return undefined;
  }
}

function decodeFrame(value: unknown): RuntimeHostPeerMeshManagementFrame {
  const frame = FRAME_SCHEMA.parse(value);
  if (frame.kind !== 'result') return frame;

  switch (frame.action) {
    case 'status':
      return { kind: 'result', action: 'status', result: decodePeerMeshQueryResult(frame.result) };
    case 'leave':
      return { kind: 'result', action: 'leave', result: decodePeerMeshQueryResult(frame.result) };
    case 'reconcile':
      return {
        kind: 'result',
        action: 'reconcile',
        result: decodePeerMeshQueryResult(frame.result),
      };
    case 'transit':
      return {
        kind: 'result',
        action: 'transit',
        result: decodePeerMeshQueryResult(frame.result),
      };
    case 'rename':
      return {
        kind: 'result',
        action: 'rename',
        result: decodePeerMeshQueryResult(frame.result),
      };
    case 'rename-mesh':
      return {
        kind: 'result',
        action: 'rename-mesh',
        result: decodePeerMeshQueryResult(frame.result),
      };
    case 'invite':
      return {
        kind: 'result',
        action: 'invite',
        result: decodePeerMeshInvitationResult(frame.result),
      };
    case 'create':
      return { kind: 'result', action: 'create', result: decodePeerMeshQueryResult(frame.result) };
    case 'join':
      return { kind: 'result', action: 'join', result: decodePeerMeshQueryResult(frame.result) };
    case 'remove':
      return { kind: 'result', action: 'remove', result: decodePeerMeshQueryResult(frame.result) };
    case 'close':
      return { kind: 'result', action: 'close', result: decodePeerMeshQueryResult(frame.result) };
  }
}
