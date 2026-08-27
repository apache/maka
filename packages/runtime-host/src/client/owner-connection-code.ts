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
import { requireHostRootId } from '../protocol/index.js';
import {
  RUNTIME_HOST_ACCESS_CREDENTIAL_MAX_BYTES,
  type RuntimeHostRemoteTransport,
} from './host-profile.js';

const PREFIX = 'maka-runtime-host:connect:v1:';
const ENCODED_MAX_BYTES = 48 * 1024;
const FIELD_MAX_BYTES = 2 * 1024;
const ROUTE_MAX = 16;

const boundedString = (maxBytes: number) =>
  z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value, 'utf8') <= maxBytes);
const peerAddress = boundedString(FIELD_MAX_BYTES).refine(
  (value) => value.startsWith('/') && !/[\s\u0000-\u001f\u007f]/u.test(value),
);
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
    transport: z
      .object({
        kind: z.literal('libp2p-direct'),
        peerId: boundedString(160),
        routeHints: z.array(peerAddress).max(ROUTE_MAX),
        coordinationRelays: z.array(peerAddress).max(ROUTE_MAX),
      })
      .strict()
      .refine(
        (transport) => transport.routeHints.length > 0 || transport.coordinationRelays.length > 0,
      ),
    credential: boundedString(RUNTIME_HOST_ACCESS_CREDENTIAL_MAX_BYTES),
  })
  .strict();

export interface RuntimeHostOwnerConnectionCode {
  readonly name: string;
  readonly rootId: string;
  readonly transport: Extract<RuntimeHostRemoteTransport, { kind: 'libp2p-direct' }>;
  readonly credential: string;
}

export function encodeRuntimeHostOwnerConnectionCode(
  input: RuntimeHostOwnerConnectionCode,
): string {
  const payload = payloadSchema.parse({ schemaVersion: 1, ...input });
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
    return {
      name: payload.name,
      rootId: requireHostRootId(payload.rootId),
      transport: payload.transport,
      credential: payload.credential,
    };
  } catch (error) {
    throw new Error('Runtime Host connection code is invalid', { cause: error });
  }
}
