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
import { consumeAccessCredentialDelivery } from '../control/access-credential-delivery.js';
import { REMOTE_OWNER_OPERATION_GRANTS, requireHostRootId } from '../protocol/index.js';
import type { RuntimeHostConnection } from './connection.js';
import {
  decodeRuntimeHostRemoteTransport,
  RUNTIME_HOST_ACCESS_CREDENTIAL_MAX_BYTES,
  type RuntimeHostRemoteTransport,
} from './host-profile.js';

const PREFIX = 'maka-runtime-host:connect:v1:';
const ENCODED_MAX_BYTES = 48 * 1024;

export const REMOTE_DESKTOP_OWNER_ACCESS_POLICY = Object.freeze({
  principalKind: 'remote_owner' as const,
  operationGrants: REMOTE_OWNER_OPERATION_GRANTS,
  canPublishClientCapabilities: true,
  canUseHostPaths: false,
});

const boundedString = (maxBytes: number) =>
  z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value, 'utf8') <= maxBytes);
const nameSchema = boundedString(128);
const payloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: boundedString(128),
    rootId: z.string().refine((value) => {
      try {
        requireHostRootId(value);
        return true;
      } catch {
        return false;
      }
    }),
    transport: z.unknown(),
    credential: boundedString(RUNTIME_HOST_ACCESS_CREDENTIAL_MAX_BYTES),
  })
  .strict();

export interface RuntimeHostOwnerConnectionCode {
  readonly name: string;
  readonly rootId: string;
  readonly transport: Extract<RuntimeHostRemoteTransport, { kind: 'libp2p-direct' }>;
  readonly credential: string;
}

export interface IssueRuntimeHostOwnerConnectionCodeInput {
  readonly rootPath: string;
  readonly name: string;
  readonly principalId: string;
  readonly expectedPeerId?: string;
  readonly client: Pick<RuntimeHostConnection, 'request' | 'rootId' | 'status'>;
}

/**
 * Issue one pending Owner credential and bind it to the Host's current,
 * authenticated Direct peer endpoint. The credential remains one-time and
 * short-lived until the importing Client finalizes it.
 */
export async function issueRuntimeHostOwnerConnectionCode(
  input: IssueRuntimeHostOwnerConnectionCodeInput,
): Promise<string> {
  const name = nameSchema.parse(input.name);
  const rootId = requireHostRootId(input.client.rootId);
  const endpoint = (await input.client.status()).peerEndpoint;
  if (!endpoint) throw new Error('Runtime Host Direct peer is not available');
  if (input.expectedPeerId && endpoint.peerId !== input.expectedPeerId) {
    throw new Error('Runtime Host Direct peer identity changed');
  }
  const transport = requireDirectPeerTransport({ kind: 'libp2p-direct', ...endpoint });
  const prepared = await input.client.request('access.credential.prepare', {
    ...REMOTE_DESKTOP_OWNER_ACCESS_POLICY,
    principalId: input.principalId,
    bindClientInstance: true,
  });
  const credential = await consumeAccessCredentialDelivery(
    input.rootPath,
    prepared.deliveryId,
    prepared.credentialId,
  );
  return encodeRuntimeHostOwnerConnectionCode({ name, rootId, transport, credential });
}

export function encodeRuntimeHostOwnerConnectionCode(
  input: RuntimeHostOwnerConnectionCode,
): string {
  const transport = requireDirectPeerTransport(input.transport);
  const payload = payloadSchema.parse({ schemaVersion: 1, ...input, transport });
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  if (Buffer.byteLength(encoded, 'utf8') > ENCODED_MAX_BYTES) {
    throw new RangeError('Runtime Host connection code is too large');
  }
  return `${PREFIX}${encoded}`;
}

export function decodeRuntimeHostOwnerConnectionCode(
  value: unknown,
): RuntimeHostOwnerConnectionCode {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) {
    throw new Error('Runtime Host connection code is invalid');
  }
  const encoded = value.slice(PREFIX.length);
  if (encoded.length === 0 || Buffer.byteLength(encoded, 'utf8') > ENCODED_MAX_BYTES) {
    throw new Error('Runtime Host connection code is invalid');
  }
  try {
    const payload = payloadSchema.parse(
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')),
    );
    const transport = requireDirectPeerTransport(payload.transport);
    return {
      name: payload.name,
      rootId: requireHostRootId(payload.rootId),
      transport,
      credential: payload.credential,
    };
  } catch (error) {
    throw new Error('Runtime Host connection code is invalid', { cause: error });
  }
}

function requireDirectPeerTransport(
  value: unknown,
): Extract<RuntimeHostRemoteTransport, { kind: 'libp2p-direct' }> {
  const transport = decodeRuntimeHostRemoteTransport(value);
  if (transport.kind !== 'libp2p-direct') {
    throw new Error('Runtime Host connection code requires a Direct peer transport');
  }
  return transport;
}
