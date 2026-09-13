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

export type SkillInvocationMode = 'explicit' | 'model_tool';

export type SkillInvocationFailureReason =
  | 'invalid_name'
  | 'not_found'
  | 'disabled'
  | 'host_incompatible'
  | 'resolution_failed'
  | 'too_many_requests';

export type PerRequestSkillInvocationFailureReason = Exclude<
  SkillInvocationFailureReason,
  'too_many_requests'
>;

export type SkillInvocationReceipt =
  | {
      invocation: SkillInvocationMode;
      request: string;
      success: true;
      ref: string;
      id: string;
      name: string;
      scope: 'project' | 'workspace' | 'user' | 'custom';
      source: 'maka' | 'agents' | 'legacy' | 'custom';
      truncated: boolean;
    }
  | {
      invocation: SkillInvocationMode;
      request: string;
      success: false;
      reason: PerRequestSkillInvocationFailureReason;
    }
  | {
      invocation: 'explicit';
      success: false;
      reason: 'too_many_requests';
      requestLimit: number;
    };

export type SkillInvocationFailure =
  | {
      request: string;
      reason: PerRequestSkillInvocationFailureReason;
    }
  | {
      reason: 'too_many_requests';
      requestLimit: number;
    };

export interface SkillInvocationResult {
  readonly loaded: readonly { readonly id: string; readonly name: string }[];
  readonly failed: readonly SkillInvocationFailure[];
  readonly receipts: readonly SkillInvocationReceipt[];
}

const SKILL_INVOCATION_MAX_ENTRIES = 50;
export const SKILL_INVOCATION_REQUEST_MAX_BYTES = 512;
export const SKILL_INVOCATION_REF_MAX_BYTES = 512;
export const SKILL_INVOCATION_ID_MAX_BYTES = 128;
export const SKILL_INVOCATION_NAME_MAX_BYTES = 256;
export const SKILL_INVOCATION_RESULT_MAX_BYTES = 72 * 1024;
const UTF8 = new TextEncoder();
const SKILL_INVOCATION_FAILURE_REASONS = new Set<PerRequestSkillInvocationFailureReason>([
  'invalid_name',
  'not_found',
  'disabled',
  'host_incompatible',
  'resolution_failed',
]);
const SKILL_INVOCATION_SCOPES = new Set(['project', 'workspace', 'user', 'custom']);
const SKILL_INVOCATION_SOURCES = new Set(['maka', 'agents', 'legacy', 'custom']);

export function decodeSkillInvocationResult(value: unknown): SkillInvocationResult {
  requireEncodedByteLimit(value, SKILL_INVOCATION_RESULT_MAX_BYTES);
  const record = requireRecord(value, ['loaded', 'failed', 'receipts']);
  const loaded = requireBoundedArray(record.loaded, 'loaded').map((entry) => {
    const item = requireRecord(entry, ['id', 'name']);
    return Object.freeze({
      id: requireBoundedText(item.id, 'Skill id', SKILL_INVOCATION_ID_MAX_BYTES),
      name: requireBoundedText(item.name, 'Skill name', SKILL_INVOCATION_NAME_MAX_BYTES),
    });
  });
  const failed = requireBoundedArray(record.failed, 'failed').map(decodeFailure);
  const receipts = requireBoundedArray(record.receipts, 'receipts').map(decodeReceipt);
  return Object.freeze({
    loaded: Object.freeze(loaded),
    failed: Object.freeze(failed),
    receipts: Object.freeze(receipts),
  });
}

function decodeFailure(value: unknown): SkillInvocationFailure {
  const record = requireObject(value);
  if (record.reason === 'too_many_requests') {
    requireExactKeys(record, ['reason', 'requestLimit']);
    return Object.freeze({
      reason: 'too_many_requests',
      requestLimit: requireRequestLimit(record.requestLimit),
    });
  }
  requireExactKeys(record, ['request', 'reason']);
  return Object.freeze({
    request: requireBoundedText(
      record.request,
      'Skill invocation request',
      SKILL_INVOCATION_REQUEST_MAX_BYTES,
    ),
    reason: requirePerRequestFailureReason(record.reason),
  });
}

function decodeReceipt(value: unknown): SkillInvocationReceipt {
  const record = requireObject(value);
  if (record.success === true) {
    requireExactKeys(record, [
      'invocation',
      'request',
      'success',
      'ref',
      'id',
      'name',
      'scope',
      'source',
      'truncated',
    ]);
    if (!SKILL_INVOCATION_SCOPES.has(record.scope as string)) {
      throw new Error('Invalid Skill invocation scope');
    }
    if (!SKILL_INVOCATION_SOURCES.has(record.source as string)) {
      throw new Error('Invalid Skill invocation source');
    }
    if (typeof record.truncated !== 'boolean') {
      throw new Error('Invalid Skill invocation truncation state');
    }
    return Object.freeze({
      invocation: requireInvocationMode(record.invocation),
      request: requireBoundedText(
        record.request,
        'Skill invocation request',
        SKILL_INVOCATION_REQUEST_MAX_BYTES,
      ),
      success: true,
      ref: requireBoundedText(record.ref, 'Skill ref', SKILL_INVOCATION_REF_MAX_BYTES),
      id: requireBoundedText(record.id, 'Skill id', SKILL_INVOCATION_ID_MAX_BYTES),
      name: requireBoundedText(record.name, 'Skill name', SKILL_INVOCATION_NAME_MAX_BYTES),
      scope: record.scope as Extract<SkillInvocationReceipt, { success: true }>['scope'],
      source: record.source as Extract<SkillInvocationReceipt, { success: true }>['source'],
      truncated: record.truncated,
    });
  }
  if (record.success !== false) throw new Error('Invalid Skill invocation receipt outcome');
  if (record.reason === 'too_many_requests') {
    requireExactKeys(record, ['invocation', 'success', 'reason', 'requestLimit']);
    if (record.invocation !== 'explicit') {
      throw new Error('Invalid overflowing Skill invocation mode');
    }
    return Object.freeze({
      invocation: 'explicit',
      success: false,
      reason: 'too_many_requests',
      requestLimit: requireRequestLimit(record.requestLimit),
    });
  }
  requireExactKeys(record, ['invocation', 'request', 'success', 'reason']);
  return Object.freeze({
    invocation: requireInvocationMode(record.invocation),
    request: requireBoundedText(
      record.request,
      'Skill invocation request',
      SKILL_INVOCATION_REQUEST_MAX_BYTES,
    ),
    success: false,
    reason: requirePerRequestFailureReason(record.reason),
  });
}

function requireInvocationMode(value: unknown): SkillInvocationMode {
  if (value !== 'explicit' && value !== 'model_tool') {
    throw new Error('Invalid Skill invocation mode');
  }
  return value;
}

function requirePerRequestFailureReason(value: unknown): PerRequestSkillInvocationFailureReason {
  if (!SKILL_INVOCATION_FAILURE_REASONS.has(value as PerRequestSkillInvocationFailureReason)) {
    throw new Error('Invalid Skill invocation failure reason');
  }
  return value as PerRequestSkillInvocationFailureReason;
}

function requireRequestLimit(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 50) {
    throw new Error('Invalid Skill invocation request limit');
  }
  return value as number;
}

function requireBoundedArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value) || value.length > SKILL_INVOCATION_MAX_ENTRIES) {
    throw new Error(`Invalid Skill invocation ${field}`);
  }
  return value;
}

function requireBoundedText(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== 'string' || value.length === 0 || UTF8.encode(value).byteLength > maxBytes) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

function requireEncodedByteLimit(value: unknown, maxBytes: number): void {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error('Invalid Skill invocation result');
  }
  if (encoded === undefined || UTF8.encode(encoded).byteLength > maxBytes) {
    throw new Error('Invalid Skill invocation result size');
  }
}

function requireRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = requireObject(value);
  requireExactKeys(record, keys);
  return record;
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Skill invocation record');
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error('Invalid Skill invocation record fields');
  }
}
