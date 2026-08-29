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

export const RUNTIME_HOST_PEER_MANAGEMENT_FRAME_PREFIX = 'MAKA_RUNTIME_HOST_PEER_MANAGEMENT_V1 ';
const FRAME_MAX_BYTES = 128 * 1024;

const ACTION_SCHEMA = z.enum(['enable', 'disable', 'status']);
const boundedString = (maxBytes: number) =>
  z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= maxBytes);
const ADDRESS_SCHEMA = boundedString(2 * 1024);
const STATUS_SCHEMA = z
  .object({
    state: z.enum(['not_configured', 'disabled', 'enabled']),
    serviceState: boundedString(128),
    peerId: boundedString(160).optional(),
    rootId: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    routeHints: z.array(ADDRESS_SCHEMA).max(16),
    coordinationRelays: z.array(ADDRESS_SCHEMA).max(16),
    automaticRelayDiscovery: z.boolean().optional(),
  })
  .strict();

const FRAME_SCHEMA = z.union([
  z
    .object({
      kind: z.literal('result'),
      action: z.enum(['enable', 'disable']),
      status: STATUS_SCHEMA,
      restarted: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('result'),
      action: z.literal('status'),
      status: STATUS_SCHEMA,
    })
    .strict(),
  z
    .object({
      kind: z.literal('error'),
      action: ACTION_SCHEMA,
      error: z
        .object({
          code: boundedString(128),
          message: boundedString(2 * 1024),
        })
        .strict(),
    })
    .strict(),
]);

export type RuntimeHostPeerManagementAction = z.infer<typeof ACTION_SCHEMA>;
export type RuntimeHostPeerStatus = z.infer<typeof STATUS_SCHEMA>;
export type RuntimeHostPeerManagementFrame = z.infer<typeof FRAME_SCHEMA>;

export function encodeRuntimeHostPeerManagementFrame(
  frame: RuntimeHostPeerManagementFrame,
): string {
  const encoded = Buffer.from(JSON.stringify(FRAME_SCHEMA.parse(frame)), 'utf8').toString(
    'base64url',
  );
  if (Buffer.byteLength(encoded, 'utf8') > FRAME_MAX_BYTES) {
    throw new RangeError('Runtime Host peer management frame exceeds the encoded size limit');
  }
  return `${RUNTIME_HOST_PEER_MANAGEMENT_FRAME_PREFIX}${encoded}\n`;
}

export function decodeRuntimeHostPeerManagementFrame(
  line: string,
): RuntimeHostPeerManagementFrame | undefined {
  const marker = line.indexOf(RUNTIME_HOST_PEER_MANAGEMENT_FRAME_PREFIX);
  if (marker < 0) return undefined;
  try {
    const encoded = line.slice(marker + RUNTIME_HOST_PEER_MANAGEMENT_FRAME_PREFIX.length).trim();
    if (encoded.length === 0 || Buffer.byteLength(encoded, 'utf8') > FRAME_MAX_BYTES) {
      return undefined;
    }
    const value: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const decoded = FRAME_SCHEMA.safeParse(value);
    return decoded.success ? decoded.data : undefined;
  } catch {
    return undefined;
  }
}
