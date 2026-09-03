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

export const RUNTIME_HOST_ACTIVATION_FRAME_PREFIX = 'MAKA_RUNTIME_HOST_ACTIVATION_V1 ';
export const RUNTIME_HOST_ACTIVATION_FRAME_MAX_BYTES = 16 * 1024;
export const RUNTIME_HOST_ACTIVATION_ERROR_CODE_MAX_BYTES = 128;
export const RUNTIME_HOST_ACTIVATION_ERROR_MESSAGE_MAX_BYTES = 2 * 1024;

const boundedString = (maximumBytes: number) =>
  z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value, 'utf8') <= maximumBytes);

const activationResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('result'),
    deploymentId: z.string().uuid(),
    configRevision: z.number().int().positive().safe(),
    rootId: z.string().regex(/^[a-f0-9]{64}$/u),
    hostEpoch: boundedString(128),
    pid: z.number().int().positive().safe(),
    protocolVersion: z.number().int().nonnegative().safe(),
    endpoint: z
      .object({
        host: z.literal('127.0.0.1'),
        port: z.number().int().min(1).max(65_535),
        websocketPath: boundedString(2_048).refine(isCanonicalRuntimeHostWebSocketPath),
      })
      .strict(),
  })
  .strict();

const activationErrorSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('error'),
    error: z
      .object({
        code: boundedString(RUNTIME_HOST_ACTIVATION_ERROR_CODE_MAX_BYTES),
        message: boundedString(RUNTIME_HOST_ACTIVATION_ERROR_MESSAGE_MAX_BYTES),
      })
      .strict(),
  })
  .strict();

const activationFrameSchema = z.discriminatedUnion('kind', [
  activationResultSchema,
  activationErrorSchema,
]);

export type RuntimeHostActivationResult = z.infer<typeof activationResultSchema>;
export type RuntimeHostActivationFrame = z.infer<typeof activationFrameSchema>;

export function encodeRuntimeHostActivationFrame(frame: RuntimeHostActivationFrame): string {
  const encoded = Buffer.from(JSON.stringify(activationFrameSchema.parse(frame))).toString(
    'base64url',
  );
  if (Buffer.byteLength(encoded, 'utf8') > RUNTIME_HOST_ACTIVATION_FRAME_MAX_BYTES) {
    throw new RangeError('Runtime Host activation frame exceeds the encoded size limit');
  }
  return `${RUNTIME_HOST_ACTIVATION_FRAME_PREFIX}${encoded}\n`;
}

export function decodeRuntimeHostActivationFrame(
  line: string,
): RuntimeHostActivationFrame | undefined {
  if (!line.startsWith(RUNTIME_HOST_ACTIVATION_FRAME_PREFIX)) return undefined;
  try {
    const encoded = line.slice(RUNTIME_HOST_ACTIVATION_FRAME_PREFIX.length).trim();
    if (
      encoded.length === 0 ||
      Buffer.byteLength(encoded, 'utf8') > RUNTIME_HOST_ACTIVATION_FRAME_MAX_BYTES
    ) {
      return undefined;
    }
    const value: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const decoded = activationFrameSchema.safeParse(value);
    return decoded.success ? decoded.data : undefined;
  } catch {
    return undefined;
  }
}
