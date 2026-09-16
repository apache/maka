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

import type { ToolResultArchiveReadResult } from './tool-result-archive.js';
import { TOOL_RESULT_ARCHIVE_EVIDENCE_MAX_BYTES } from '@maka/core/tool-result-archive-evidence';
import { readToolResultPage, resolveReadInput, type ReadInput } from './read-page.js';

export const TOOL_RESULT_ARCHIVE_RESOURCE_PROTOCOL = 'maka:';
export const TOOL_RESULT_ARCHIVE_RESOURCE_HOST = 'archive';
export const TOOL_RESULT_ARCHIVE_MAX_BYTES = TOOL_RESULT_ARCHIVE_EVIDENCE_MAX_BYTES;
const ARCHIVE_ARTIFACT_ID_PATTERN = /^[A-Za-z0-9._-]{1,160}$/;

export interface LegacyArchiveResourceIdentity {
  artifactId: string;
  storage?: never;
  bodySha256: string;
  originalBytes: number;
}

export interface LedgerArchiveResourceIdentity {
  storage: 'ledger';
  artifactId?: never;
  runtimeEventId: string;
  toolCallId: string;
  toolName: string;
  sourceProjectionDigest: `sha256:${string}`;
  previousTransitionId?: string;
  bodySha256: string;
  originalBytes: number;
}

export type ToolResultArchiveResourceIdentity =
  | LegacyArchiveResourceIdentity
  | LedgerArchiveResourceIdentity;
export type ToolResultArchiveResourceReadInput = (
  | ToolResultArchiveResourceIdentity
  | {
      storage: 'event';
      runtimeEventId: string;
    }
) & {
  sessionId: string;
  maxBytes: number;
};

export function isLedgerArchiveIdentity(value: unknown): value is LedgerArchiveResourceIdentity {
  if (!isRecord(value)) return false;
  return (
    value.storage === 'ledger' &&
    value.artifactId === undefined &&
    ['runtimeEventId', 'toolCallId', 'toolName'].every(
      (key) =>
        typeof value[key] === 'string' &&
        (value[key] as string).length > 0 &&
        (value[key] as string).length <= 512,
    ) &&
    typeof value.sourceProjectionDigest === 'string' &&
    /^sha256:[a-f0-9]{64}$/.test(value.sourceProjectionDigest) &&
    (value.previousTransitionId === undefined ||
      (typeof value.previousTransitionId === 'string' &&
        /^mptransition-[a-f0-9]{32}$/.test(value.previousTransitionId))) &&
    typeof value.bodySha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.bodySha256) &&
    Number.isSafeInteger(value.originalBytes) &&
    Number(value.originalBytes) > 0
  );
}

export interface ToolResultArchiveResourceReader {
  readArchivedToolResultResource(
    input: ToolResultArchiveResourceReadInput,
  ): Promise<ToolResultArchiveReadResult> | ToolResultArchiveReadResult;
}

export function buildToolResultArchiveResourceRef(
  input: ToolResultArchiveResourceIdentity,
): string {
  if (input.storage === 'ledger') {
    if (!isLedgerArchiveIdentity(input)) throw new Error('Invalid ledger archive identity');
    const value = [
      input.runtimeEventId,
      input.toolCallId,
      input.toolName,
      input.sourceProjectionDigest,
      input.previousTransitionId ?? null,
      input.bodySha256,
      input.originalBytes,
    ];
    return `maka://archive-ledger/v1/${encodeURIComponent(JSON.stringify(value))}`;
  }
  const artifactId = encodeURIComponent(input.artifactId);
  const sha256 = encodeURIComponent(input.bodySha256);
  return `maka://archive/${artifactId}/${sha256}/${input.originalBytes}`;
}

export function parseToolResultArchiveResourceRef(
  ref: string,
): ToolResultArchiveResourceIdentity | null {
  if (ref.startsWith('maka://archive-ledger/')) {
    try {
      const prefix = 'maka://archive-ledger/v1/';
      if (!ref.startsWith(prefix) || ref.length > 16384) return null;
      const values = JSON.parse(decodeURIComponent(ref.slice(prefix.length)));
      if (!Array.isArray(values) || values.length !== 7) return null;
      const [
        runtimeEventId,
        toolCallId,
        toolName,
        sourceProjectionDigest,
        previous,
        bodySha256,
        originalBytes,
      ] = values;
      const identity = {
        storage: 'ledger' as const,
        runtimeEventId,
        toolCallId,
        toolName,
        sourceProjectionDigest,
        ...(previous === null ? {} : { previousTransitionId: previous }),
        bodySha256,
        originalBytes,
      };
      return isLedgerArchiveIdentity(identity) &&
        buildToolResultArchiveResourceRef(identity) === ref
        ? identity
        : null;
    } catch {
      return null;
    }
  }
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    return null;
  }
  if (
    url.protocol !== TOOL_RESULT_ARCHIVE_RESOURCE_PROTOCOL ||
    url.hostname !== TOOL_RESULT_ARCHIVE_RESOURCE_HOST ||
    url.username ||
    url.password ||
    url.port
  ) {
    return null;
  }
  const pathParts = url.pathname.split('/').filter(Boolean);
  if (url.hash || url.search || pathParts.length !== 3) return null;
  let artifactId: string;
  let bodySha256: string;
  let bytesText: string;
  try {
    artifactId = decodeURIComponent(pathParts[0] ?? '');
    bodySha256 = decodeURIComponent(pathParts[1] ?? '');
    bytesText = decodeURIComponent(pathParts[2] ?? '');
  } catch {
    return null;
  }
  if (
    !ARCHIVE_ARTIFACT_ID_PATTERN.test(artifactId) ||
    !/^[a-f0-9]{64}$/i.test(bodySha256) ||
    !/^[1-9]\d*$/.test(bytesText)
  ) {
    return null;
  }
  const originalBytes = Number(bytesText);
  if (!Number.isSafeInteger(originalBytes) || originalBytes <= 0) return null;
  return { artifactId, bodySha256, originalBytes };
}

export const TOOL_RESULT_ARCHIVE_READ_INSTRUCTIONS =
  'Use Read with the next parameters to continue this result.';

/** A complete canonical event address, including when read from untrusted history. */
export function parseToolResultEventAddress(path: string): string | null {
  const prefix = 'maka://runtime/tool-results/';
  if (!path.startsWith(prefix)) return null;
  try {
    const id = decodeURIComponent(path.slice(prefix.length));
    return id.length > 0 && id.length <= 512 && `${prefix}${encodeURIComponent(id)}` === path
      ? id
      : null;
  } catch {
    return null;
  }
}

export async function readToolResultArchiveResource(
  reader: ToolResultArchiveResourceReader,
  sessionId: string,
  input: ReadInput,
  abortSignal?: AbortSignal,
): Promise<unknown> {
  const { path } = resolveReadInput(input);
  const runtimeEventId = parseToolResultEventAddress(path);
  if (!runtimeEventId)
    throw new Error('Invalid Maka address. Copy the complete path returned by the tool.');
  abortSignal?.throwIfAborted();
  const result = await reader.readArchivedToolResultResource({
    sessionId,
    storage: 'event',
    runtimeEventId,
    maxBytes: TOOL_RESULT_ARCHIVE_MAX_BYTES,
  });
  abortSignal?.throwIfAborted();
  if (!result.ok)
    return {
      error: result.reason,
      message:
        'This Maka content could not be read. Changing offset or limit will not restore it. Use the original source if it is still available.',
    };
  return readToolResultPage(result.serializedResult, input);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
