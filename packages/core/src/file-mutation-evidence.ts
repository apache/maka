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

import { createHash } from 'node:crypto';
import { stableJsonStringify } from './tool-args-identity.js';

/** Versioned evidence contracts only; neither declaration authorizes recovery execution. */
export const FILE_WRITE_EVIDENCE_CONTRACT = Object.freeze({
  id: 'builtin.Write.utf8',
  version: 1,
  evidenceKind: 'file_state_v1',
  algorithm: 'overwrite_utf8_v1',
  maxFileBytes: 1_048_576,
  maxResultBytes: 262_144,
  pathPolicy: 'canonical_target_no_follow_v1',
} as const);

export const FILE_EDIT_EVIDENCE_CONTRACT = Object.freeze({
  ...FILE_WRITE_EVIDENCE_CONTRACT,
  id: 'builtin.Edit.utf8',
  algorithm: 'unique_replace_utf8_v1',
} as const);

export type FileMutation =
  | { kind: 'write'; content: string }
  | { kind: 'edit'; oldString: string; newString: string };

export interface FileWriteResult {
  kind: 'write';
  ok: true;
  path: string;
  bytes: number;
  diff?: string;
}
export interface FileEditResult {
  kind: 'edit';
  ok: true;
  path: string;
  replacements: 1;
  matchedVia: 'exact' | 'line-trimmed' | 'whitespace' | 'escape';
  startLine: number;
  endLine: number;
  diff?: string;
}

export interface FileIdentity {
  dev: string;
  ino: string;
}

/** Host identities; a sandbox may synthesize different directory inodes. */
export interface FileMutationDirectories {
  workspace: FileIdentity;
  parent: FileIdentity;
}

export interface FileMutationObservation {
  contract: typeof FILE_WRITE_EVIDENCE_CONTRACT | typeof FILE_EDIT_EVIDENCE_CONTRACT;
  workspace: { path: string; identity: FileIdentity };
  target: { path: string; parentIdentity: FileIdentity };
  before:
    | { kind: 'missing' }
    | { kind: 'file'; identity: FileIdentity; bytes: number; digest: string };
  after: { bytes: number; digest: string };
  result: FileWriteResult | FileEditResult;
}

export interface FileMutationEvidenceBinding {
  sessionId: string;
  invocationId: string;
  runId: string;
  turnId: string;
  operationId: string;
  dispatchEventId: string;
  providerToolCallId: string;
  canonicalArgsHash: string;
}

export interface FileMutationEvidence {
  observation: FileMutationObservation;
  binding: FileMutationEvidenceBinding;
  digest: string;
}

export function fileEvidenceDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJsonStringify(value)).digest('hex')}`;
}

export function bindFileMutationEvidence(
  observation: FileMutationObservation,
  binding: FileMutationEvidenceBinding,
): FileMutationEvidence {
  const body = structuredClone({ observation, binding });
  if (!isFileMutationObservation(body.observation) || !isBinding(body.binding)) {
    throw new Error('Invalid file mutation evidence');
  }
  return { ...body, digest: fileEvidenceDigest(body) };
}

export function isFileMutationEvidence(value: unknown): value is FileMutationEvidence {
  try {
    if (!record(value, ['observation', 'binding', 'digest'])) return false;
    return (
      isFileMutationObservation(value.observation) &&
      isBinding(value.binding) &&
      value.digest ===
        fileEvidenceDigest({ observation: value.observation, binding: value.binding })
    );
  } catch {
    return false;
  }
}

export function isFileMutationObservation(value: unknown): value is FileMutationObservation {
  try {
    return validateObservation(value);
  } catch {
    return false;
  }
}

function validateObservation(value: unknown): value is FileMutationObservation {
  if (!record(value, ['contract', 'workspace', 'target', 'before', 'after', 'result']))
    return false;
  const { contract, workspace, target, before, after, result } = value;
  return (
    record(contract, Object.keys(FILE_WRITE_EVIDENCE_CONTRACT)) &&
    (stableJsonStringify(contract) === stableJsonStringify(FILE_WRITE_EVIDENCE_CONTRACT) ||
      stableJsonStringify(contract) === stableJsonStringify(FILE_EDIT_EVIDENCE_CONTRACT)) &&
    record(workspace, ['path', 'identity']) &&
    path(workspace.path) &&
    identity(workspace.identity) &&
    record(target, ['path', 'parentIdentity']) &&
    path(target.path) &&
    identity(target.parentIdentity) &&
    ((record(before, ['kind']) && before.kind === 'missing') ||
      (record(before, ['kind', 'identity', 'bytes', 'digest']) &&
        before.kind === 'file' &&
        identity(before.identity) &&
        bytes(before.bytes) &&
        digest(before.digest))) &&
    record(after, ['bytes', 'digest']) &&
    bytes(after.bytes) &&
    digest(after.digest) &&
    ((contract.id === FILE_WRITE_EVIDENCE_CONTRACT.id &&
      record(result, ['kind', 'ok', 'path', 'bytes'], ['diff']) &&
      result.kind === 'write' &&
      result.bytes === after.bytes) ||
      (contract.id === FILE_EDIT_EVIDENCE_CONTRACT.id &&
        before.kind === 'file' &&
        record(
          result,
          ['kind', 'ok', 'path', 'replacements', 'matchedVia', 'startLine', 'endLine'],
          ['diff'],
        ) &&
        result.kind === 'edit' &&
        result.replacements === 1 &&
        ['exact', 'line-trimmed', 'whitespace', 'escape'].includes(result.matchedVia as string) &&
        Number.isSafeInteger(result.startLine) &&
        (result.startLine as number) >= 1 &&
        Number.isSafeInteger(result.endLine) &&
        (result.endLine as number) >= (result.startLine as number))) &&
    result.ok === true &&
    result.path === target.path &&
    (result.diff === undefined || typeof result.diff === 'string') &&
    Buffer.byteLength(stableJsonStringify(result), 'utf8') <=
      FILE_WRITE_EVIDENCE_CONTRACT.maxResultBytes
  );
}

function isBinding(value: unknown): value is FileMutationEvidenceBinding {
  return (
    record(value, [
      'sessionId',
      'invocationId',
      'runId',
      'turnId',
      'operationId',
      'dispatchEventId',
      'providerToolCallId',
      'canonicalArgsHash',
    ]) &&
    Object.values(value).every((item) => typeof item === 'string' && item.length > 0) &&
    digest(value.canonicalArgsHash)
  );
}

function record(
  value: unknown,
  required: string[],
  optional: string[] = [],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}

function identity(value: unknown): value is FileIdentity {
  return (
    record(value, ['dev', 'ino']) &&
    typeof value.dev === 'string' &&
    /^\d+$/.test(value.dev) &&
    typeof value.ino === 'string' &&
    /^\d+$/.test(value.ino)
  );
}

function digest(value: unknown): boolean {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function path(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.includes('\0') &&
    (value.startsWith('/') || value.startsWith('\\\\') || /^[a-z]:[\\/]/i.test(value))
  );
}

function bytes(value: unknown): boolean {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= FILE_WRITE_EVIDENCE_CONTRACT.maxFileBytes
  );
}
