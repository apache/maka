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
import { isCanonicalRuntimeHostWebSocketPath } from '../protocol/index.js';

export const RUNTIME_HOST_SETUP_FRAME_PREFIX = 'MAKA_RUNTIME_HOST_SETUP_V1 ';
const SETUP_FRAME_MAX_BYTES = 32 * 1024;
const SETUP_FIELD_MAX_BYTES = 1024;
const SETUP_CREDENTIAL_MAX_BYTES = 8 * 1024;
export const RUNTIME_HOST_SETUP_ERROR_CODE_MAX_BYTES = 128;
export const RUNTIME_HOST_SETUP_ERROR_MESSAGE_MAX_BYTES = SETUP_FIELD_MAX_BYTES;
const SETUP_PHASES = [
  'checking_environment',
  'installing_package',
  'installing_service',
  'pairing_client',
  'verifying_connection',
] as const;

export type RuntimeHostSetupPhase = (typeof SETUP_PHASES)[number];

const boundedString = (maxBytes: number) =>
  z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value, 'utf8') <= maxBytes);
const frameBase = {
  schemaVersion: z.literal(1),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
} as const;
const SETUP_FRAME_SCHEMA = z.discriminatedUnion('kind', [
  z
    .object({
      ...frameBase,
      kind: z.literal('progress'),
      phase: z.enum(SETUP_PHASES),
    })
    .strict(),
  z
    .object({
      ...frameBase,
      kind: z.literal('complete'),
      version: boundedString(128),
      serviceId: z.string().regex(/^[a-f0-9]{64}$/u),
      operatorPath: boundedString(4 * 1024).refine(
        (value) => value.startsWith('/') && !/[\u0000-\u001f\u007f]/u.test(value),
      ),
      rootPath: boundedString(4 * 1024).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value)),
      rootId: z.string().regex(/^[a-f0-9]{64}$/u),
      endpoint: boundedString(SETUP_FIELD_MAX_BYTES).refine(
        (value) => parseRuntimeHostSetupEndpoint(value) !== undefined,
      ),
      credentialId: boundedString(SETUP_FIELD_MAX_BYTES),
      credential: boundedString(SETUP_CREDENTIAL_MAX_BYTES),
    })
    .strict(),
  z
    .object({
      ...frameBase,
      kind: z.literal('error'),
      error: z
        .object({
          code: boundedString(RUNTIME_HOST_SETUP_ERROR_CODE_MAX_BYTES),
          message: boundedString(RUNTIME_HOST_SETUP_ERROR_MESSAGE_MAX_BYTES),
        })
        .strict(),
    })
    .strict(),
]);

export type RuntimeHostSetupFrame = z.infer<typeof SETUP_FRAME_SCHEMA>;

export interface RuntimeHostSetupEndpoint {
  readonly port: number;
  readonly websocketPath: string;
}

export function parseRuntimeHostSetupEndpoint(value: string): RuntimeHostSetupEndpoint | undefined {
  try {
    const url = new URL(value);
    const port = Number(url.port);
    if (
      url.protocol !== 'ws:' ||
      (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]' && url.hostname !== '::1') ||
      url.username ||
      url.password ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535 ||
      url.search ||
      url.hash ||
      !isCanonicalRuntimeHostWebSocketPath(url.pathname)
    ) {
      return undefined;
    }
    return { port, websocketPath: url.pathname };
  } catch {
    return undefined;
  }
}

export function encodeRuntimeHostSetupFrame(frame: RuntimeHostSetupFrame): string {
  const encoded = Buffer.from(JSON.stringify(SETUP_FRAME_SCHEMA.parse(frame))).toString(
    'base64url',
  );
  if (Buffer.byteLength(encoded, 'utf8') > SETUP_FRAME_MAX_BYTES) {
    throw new RangeError('Runtime Host setup frame exceeds the encoded size limit');
  }
  return `${RUNTIME_HOST_SETUP_FRAME_PREFIX}${encoded}\n`;
}

export function decodeRuntimeHostSetupFrame(line: string): RuntimeHostSetupFrame | undefined {
  const marker = line.indexOf(RUNTIME_HOST_SETUP_FRAME_PREFIX);
  if (marker === -1) return undefined;
  try {
    const encoded = line.slice(marker + RUNTIME_HOST_SETUP_FRAME_PREFIX.length).trim();
    if (encoded.length === 0 || Buffer.byteLength(encoded, 'utf8') > SETUP_FRAME_MAX_BYTES) {
      return undefined;
    }
    const value: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const decoded = SETUP_FRAME_SCHEMA.safeParse(value);
    return decoded.success ? decoded.data : undefined;
  } catch {
    return undefined;
  }
}
