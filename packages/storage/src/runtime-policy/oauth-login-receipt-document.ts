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

import {
  decodeConnectionSlug,
  decodeProviderType,
  decodeRuntimePolicyEntityId,
} from '@maka/core/runtime-policy';
import { integer, record } from './codec.js';
import { codecError, decodePersistedDomain } from './errors.js';
import { readBoundedJsonDocument, writeJsonDocument } from './document-io.js';
import type {
  InteractiveOAuthConnectionIdentity,
  InteractiveOAuthLoginProvider,
  InteractiveOAuthLoginTarget,
} from './operations.js';

const FILE = 'runtime-policy-oauth-login-receipts.json';
const SCHEMA_VERSION = 1 as const;
const MAX_BYTES = 256 * 1024;
export const MAX_INTERACTIVE_OAUTH_LOGIN_RECEIPTS = 256;

export interface InteractiveOAuthLoginReceipt {
  readonly attemptId: string;
  readonly target: InteractiveOAuthLoginTarget;
  readonly connection: InteractiveOAuthConnectionIdentity;
  readonly phase: 'authenticated';
  readonly completionOrder: number;
}

interface ReceiptDocument {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly nextCompletionOrder: number;
  readonly receipts: readonly InteractiveOAuthLoginReceipt[];
}

const EMPTY: ReceiptDocument = {
  schemaVersion: SCHEMA_VERSION,
  nextCompletionOrder: 1,
  receipts: [],
};

export async function readInteractiveOAuthLoginReceipts(root: string): Promise<ReceiptDocument> {
  const value = await readBoundedJsonDocument(root, FILE, MAX_BYTES);
  if (value === undefined) return EMPTY;
  const document = record(value, FILE, 'invalid_document', [
    'schemaVersion',
    'nextCompletionOrder',
    'receipts',
  ]);
  if (document.schemaVersion !== SCHEMA_VERSION) {
    throw codecError('invalid_document', `${FILE} has an unsupported schema version`);
  }
  if (!Array.isArray(document.receipts)) {
    throw codecError('invalid_document', `${FILE}.receipts must be an array`);
  }
  const nextCompletionOrder = integer(
    document.nextCompletionOrder,
    `${FILE}.nextCompletionOrder`,
    1,
    Number.MAX_SAFE_INTEGER,
    'invalid_document',
  );
  const receipts = document.receipts.map((item, index) => decodeReceipt(item, index));
  if (receipts.length > MAX_INTERACTIVE_OAUTH_LOGIN_RECEIPTS) {
    throw codecError('invalid_document', `${FILE} exceeds its receipt limit`);
  }
  const attemptIds = new Set<string>();
  let previousOrder = 0;
  for (const receipt of receipts) {
    if (attemptIds.has(receipt.attemptId)) {
      throw codecError('invalid_document', `${FILE} repeats an attempt id`);
    }
    attemptIds.add(receipt.attemptId);
    if (receipt.completionOrder <= previousOrder) {
      throw codecError('invalid_document', `${FILE} receipts are not in completion order`);
    }
    previousOrder = receipt.completionOrder;
  }
  if (previousOrder >= nextCompletionOrder) {
    throw codecError('invalid_document', `${FILE} completion order is invalid`);
  }
  return { schemaVersion: SCHEMA_VERSION, nextCompletionOrder, receipts };
}

export function findInteractiveOAuthLoginReceipt(
  document: ReceiptDocument,
  attemptId: string,
): InteractiveOAuthLoginReceipt | undefined {
  return document.receipts.find((receipt) => receipt.attemptId === attemptId);
}

export async function upsertInteractiveOAuthLoginReceipt(
  root: string,
  input: Omit<InteractiveOAuthLoginReceipt, 'phase' | 'completionOrder'>,
): Promise<InteractiveOAuthLoginReceipt> {
  if (!targetMatchesIdentity(input.target, input.connection)) {
    throw codecError('invalid_document', 'OAuth login receipt identity is inconsistent');
  }
  const document = await readInteractiveOAuthLoginReceipts(root);
  const existing = findInteractiveOAuthLoginReceipt(document, input.attemptId);
  if (existing) {
    if (
      !sameTarget(existing.target, input.target) ||
      !sameIdentity(existing.connection, input.connection)
    ) {
      throw codecError(
        'invalid_document',
        'OAuth login receipt conflicts with the enrollment intent',
      );
    }
    return existing;
  }
  if (document.nextCompletionOrder >= Number.MAX_SAFE_INTEGER) {
    throw codecError('invalid_document', 'OAuth login receipt order is exhausted');
  }
  const receipt: InteractiveOAuthLoginReceipt = {
    ...input,
    phase: 'authenticated',
    completionOrder: document.nextCompletionOrder,
  };
  const receipts = [...document.receipts, receipt].slice(-MAX_INTERACTIVE_OAUTH_LOGIN_RECEIPTS);
  await writeJsonDocument(
    root,
    FILE,
    {
      schemaVersion: SCHEMA_VERSION,
      nextCompletionOrder: document.nextCompletionOrder + 1,
      receipts,
    } satisfies ReceiptDocument,
    MAX_BYTES,
  );
  return receipt;
}

export function sameInteractiveOAuthLoginTarget(
  actual: InteractiveOAuthLoginTarget,
  expected: InteractiveOAuthLoginTarget,
): boolean {
  return sameTarget(actual, expected);
}

function decodeReceipt(value: unknown, index: number): InteractiveOAuthLoginReceipt {
  const item = record(value, `${FILE}.receipts[${index}]`, 'invalid_document', [
    'attemptId',
    'target',
    'connection',
    'phase',
    'completionOrder',
  ]);
  if (item.phase !== 'authenticated') {
    throw codecError('invalid_document', 'OAuth login receipt phase is invalid');
  }
  const target = decodeTarget(item.target);
  const connection = decodeIdentity(item.connection);
  if (!targetMatchesIdentity(target, connection)) {
    throw codecError('invalid_document', 'OAuth login receipt identity is inconsistent');
  }
  return {
    attemptId: decodeAttemptId(item.attemptId),
    target,
    connection,
    phase: 'authenticated',
    completionOrder: integer(
      item.completionOrder,
      `${FILE}.receipts[${index}].completionOrder`,
      1,
      Number.MAX_SAFE_INTEGER,
      'invalid_document',
    ),
  };
}

function decodeTarget(value: unknown): InteractiveOAuthLoginTarget {
  const base = record(
    value,
    'OAuth login receipt target',
    'invalid_document',
    ['kind', 'providerType', 'connectionId'],
    ['kind'],
  );
  if (base.kind === 'create') {
    const item = record(value, 'OAuth create target', 'invalid_document', ['kind', 'providerType']);
    return { kind: 'create', providerType: decodeOAuthProvider(item.providerType) };
  }
  if (base.kind === 'existing') {
    const item = record(value, 'OAuth existing target', 'invalid_document', [
      'kind',
      'connectionId',
    ]);
    return { kind: 'existing', connectionId: decodeId(item.connectionId) };
  }
  throw codecError('invalid_document', 'OAuth login receipt target kind is invalid');
}

function decodeIdentity(value: unknown): InteractiveOAuthConnectionIdentity {
  const item = record(value, 'OAuth login receipt connection', 'invalid_document', [
    'connectionId',
    'slug',
    'providerType',
  ]);
  return {
    connectionId: decodeId(item.connectionId),
    slug: decodePersistedDomain(() => decodeConnectionSlug(item.slug)),
    providerType: decodeOAuthProvider(item.providerType),
  };
}

function decodeOAuthProvider(value: unknown): InteractiveOAuthLoginProvider {
  const providerType = decodePersistedDomain(() => decodeProviderType(value));
  if (
    providerType !== 'openai-codex' &&
    providerType !== 'xai-oauth' &&
    providerType !== 'github-copilot'
  ) {
    throw codecError('invalid_document', 'OAuth login receipt provider is invalid');
  }
  return providerType;
}

function decodeId(value: unknown): string {
  return decodePersistedDomain(() => decodeRuntimePolicyEntityId(value));
}

function decodeAttemptId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw codecError('invalid_document', 'OAuth login receipt attempt id is invalid');
  }
  return value;
}

function sameTarget(actual: InteractiveOAuthLoginTarget, expected: InteractiveOAuthLoginTarget) {
  return (
    actual.kind === expected.kind &&
    (actual.kind === 'create'
      ? expected.kind === 'create' && actual.providerType === expected.providerType
      : expected.kind === 'existing' && actual.connectionId === expected.connectionId)
  );
}

function sameIdentity(
  actual: InteractiveOAuthConnectionIdentity,
  expected: InteractiveOAuthConnectionIdentity,
) {
  return (
    actual.connectionId === expected.connectionId &&
    actual.slug === expected.slug &&
    actual.providerType === expected.providerType
  );
}

function targetMatchesIdentity(
  target: InteractiveOAuthLoginTarget,
  connection: InteractiveOAuthConnectionIdentity,
): boolean {
  return target.kind === 'create'
    ? target.providerType === connection.providerType
    : target.connectionId === connection.connectionId;
}
