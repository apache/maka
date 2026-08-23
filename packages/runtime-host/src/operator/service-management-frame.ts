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

export const RUNTIME_HOST_SERVICE_MANAGEMENT_FRAME_PREFIX =
  'MAKA_RUNTIME_HOST_SERVICE_MANAGEMENT_V1 ';
export const RUNTIME_HOST_SERVICE_LOG_MAX_BYTES = 48 * 1024;
export const RUNTIME_HOST_SERVICE_ERROR_CODE_MAX_BYTES = 128;
export const RUNTIME_HOST_SERVICE_ERROR_MESSAGE_MAX_BYTES = 2 * 1024;

const FRAME_MAX_BYTES = 96 * 1024;
const PATH_MAX_BYTES = 4 * 1024;
const FIELD_MAX_BYTES = 512;
const SERVICE_ACTIONS = [
  'install',
  'status',
  'start',
  'stop',
  'restart',
  'logs',
  'uninstall',
] as const;
const SERVICE_STATES = ['not_installed', 'stopped', 'starting', 'running', 'failed'] as const;

const boundedString = (maxBytes: number) =>
  z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= maxBytes);
const boundedNonEmptyString = (maxBytes: number) =>
  z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value, 'utf8') <= maxBytes);

const SERVICE_SUMMARY_SCHEMA = z
  .object({
    platform: boundedNonEmptyString(FIELD_MAX_BYTES),
    arch: boundedNonEmptyString(FIELD_MAX_BYTES),
    osRelease: boundedNonEmptyString(FIELD_MAX_BYTES),
    state: z.enum(SERVICE_STATES),
    pid: z.number().int().positive().nullable(),
    lastExitCode: z.number().int().nonnegative().nullable(),
    installedVersion: boundedString(FIELD_MAX_BYTES).nullable(),
    stateRoot: boundedString(PATH_MAX_BYTES).optional(),
    projectDirectoryRoots: z
      .array(
        z
          .object({
            label: boundedString(FIELD_MAX_BYTES),
            path: boundedString(PATH_MAX_BYTES),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();

const SERVICE_MANAGEMENT_FRAME_SCHEMA = z.discriminatedUnion('kind', [
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal('result'),
      action: z.enum(SERVICE_ACTIONS),
      service: SERVICE_SUMMARY_SCHEMA,
      retainedStateRoot: boundedString(PATH_MAX_BYTES).optional(),
      logs: boundedString(RUNTIME_HOST_SERVICE_LOG_MAX_BYTES).optional(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal('error'),
      action: z.enum(SERVICE_ACTIONS),
      error: z
        .object({
          code: boundedNonEmptyString(RUNTIME_HOST_SERVICE_ERROR_CODE_MAX_BYTES),
          message: boundedNonEmptyString(RUNTIME_HOST_SERVICE_ERROR_MESSAGE_MAX_BYTES),
        })
        .strict(),
    })
    .strict(),
]);

export type RuntimeHostServiceManagementAction = (typeof SERVICE_ACTIONS)[number];
export type RuntimeHostServiceManagementFrame = z.infer<typeof SERVICE_MANAGEMENT_FRAME_SCHEMA>;
export type RuntimeHostServiceSummary = z.infer<typeof SERVICE_SUMMARY_SCHEMA>;

export function encodeRuntimeHostServiceManagementFrame(
  frame: RuntimeHostServiceManagementFrame,
): string {
  const encoded = Buffer.from(
    JSON.stringify(SERVICE_MANAGEMENT_FRAME_SCHEMA.parse(frame)),
  ).toString('base64url');
  if (Buffer.byteLength(encoded, 'utf8') > FRAME_MAX_BYTES) {
    throw new RangeError('Runtime Host service management frame exceeds the encoded size limit');
  }
  return `${RUNTIME_HOST_SERVICE_MANAGEMENT_FRAME_PREFIX}${encoded}\n`;
}

export function decodeRuntimeHostServiceManagementFrame(
  line: string,
): RuntimeHostServiceManagementFrame | undefined {
  const marker = line.indexOf(RUNTIME_HOST_SERVICE_MANAGEMENT_FRAME_PREFIX);
  if (marker === -1) return undefined;
  try {
    const encoded = line.slice(marker + RUNTIME_HOST_SERVICE_MANAGEMENT_FRAME_PREFIX.length).trim();
    if (encoded.length === 0 || Buffer.byteLength(encoded, 'utf8') > FRAME_MAX_BYTES) {
      return undefined;
    }
    const value: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const decoded = SERVICE_MANAGEMENT_FRAME_SCHEMA.safeParse(value);
    return decoded.success ? decoded.data : undefined;
  } catch {
    return undefined;
  }
}
