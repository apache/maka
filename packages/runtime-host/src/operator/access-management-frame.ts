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

export const RUNTIME_HOST_ACCESS_MANAGEMENT_FRAME_PREFIX =
  'MAKA_RUNTIME_HOST_ACCESS_MANAGEMENT_V1 ';
export const RUNTIME_HOST_ACCESS_MANAGEMENT_ERROR_CODE_MAX_BYTES = 128;
export const RUNTIME_HOST_ACCESS_MANAGEMENT_ERROR_MESSAGE_MAX_BYTES = 2 * 1024;

const FRAME_MAX_BYTES = 768 * 1024;
const CREDENTIAL_MAX_BYTES = 8 * 1024;
const CONNECTION_CODE_MAX_BYTES = 64 * 1024;
const ACCESS_ACTIONS = ['list', 'prepare', 'revoke', 'connection-code'] as const;

const boundedString = (maxBytes: number) =>
  z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value, 'utf8') <= maxBytes);
const CREDENTIAL_METADATA_SCHEMA = z
  .object({
    credentialId: boundedString(128),
    credentialFingerprint: z.string().regex(/^[a-f0-9]{32}$/u),
    principalKind: z.enum(['remote_owner', 'capability_provider']),
    principalId: boundedString(128),
    status: z.enum(['active', 'pending']),
    operationGrants: z.array(boundedString(128)).max(256),
    canPublishClientCapabilities: z.boolean(),
    canUseHostPaths: z.boolean(),
    createdAt: boundedString(64),
    expiresAt: boundedString(64).optional(),
  })
  .strict();

const ACCESS_MANAGEMENT_FRAME_SCHEMA = z.union([
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal('result'),
      action: z.literal('list'),
      credentials: z.array(CREDENTIAL_METADATA_SCHEMA),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal('result'),
      action: z.literal('prepare'),
      credential: boundedString(CREDENTIAL_MAX_BYTES),
      credentials: z.array(CREDENTIAL_METADATA_SCHEMA),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal('result'),
      action: z.literal('revoke'),
      credentialId: boundedString(128),
      revoked: z.boolean(),
      credentials: z.array(CREDENTIAL_METADATA_SCHEMA),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal('result'),
      action: z.literal('connection-code'),
      connectionCode: boundedString(CONNECTION_CODE_MAX_BYTES),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal('error'),
      action: z.enum(ACCESS_ACTIONS),
      error: z
        .object({
          code: boundedString(RUNTIME_HOST_ACCESS_MANAGEMENT_ERROR_CODE_MAX_BYTES),
          message: boundedString(RUNTIME_HOST_ACCESS_MANAGEMENT_ERROR_MESSAGE_MAX_BYTES),
        })
        .strict(),
    })
    .strict(),
]);

export type RuntimeHostAccessManagementAction = (typeof ACCESS_ACTIONS)[number];
export type RuntimeHostAccessManagementFrame = z.infer<typeof ACCESS_MANAGEMENT_FRAME_SCHEMA>;
export type RuntimeHostAccessCredentialMetadata = z.infer<typeof CREDENTIAL_METADATA_SCHEMA>;

export function encodeRuntimeHostAccessManagementFrame(
  frame: RuntimeHostAccessManagementFrame,
): string {
  const encoded = Buffer.from(JSON.stringify(ACCESS_MANAGEMENT_FRAME_SCHEMA.parse(frame))).toString(
    'base64url',
  );
  if (Buffer.byteLength(encoded, 'utf8') > FRAME_MAX_BYTES) {
    throw new RangeError('Runtime Host access management frame exceeds the encoded size limit');
  }
  return `${RUNTIME_HOST_ACCESS_MANAGEMENT_FRAME_PREFIX}${encoded}\n`;
}

export function decodeRuntimeHostAccessManagementFrame(
  line: string,
): RuntimeHostAccessManagementFrame | undefined {
  const marker = line.indexOf(RUNTIME_HOST_ACCESS_MANAGEMENT_FRAME_PREFIX);
  if (marker === -1) return undefined;
  try {
    const encoded = line.slice(marker + RUNTIME_HOST_ACCESS_MANAGEMENT_FRAME_PREFIX.length).trim();
    if (encoded.length === 0 || Buffer.byteLength(encoded, 'utf8') > FRAME_MAX_BYTES) {
      return undefined;
    }
    const value: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const decoded = ACCESS_MANAGEMENT_FRAME_SCHEMA.safeParse(value);
    return decoded.success ? decoded.data : undefined;
  } catch {
    return undefined;
  }
}
