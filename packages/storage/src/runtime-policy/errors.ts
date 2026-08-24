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

import { RuntimePolicyDomainDecodeError } from '@maka/core/runtime-policy';

export type RuntimePolicyStoreErrorCode =
  | 'invalid_document'
  | 'invalid_policy_input'
  | 'invalid_connection_input'
  | 'invalid_credential_input'
  | 'io_failed'
  | 'commit_outcome_unknown';

export class RuntimePolicyStoreError extends Error {
  constructor(
    readonly code: RuntimePolicyStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RuntimePolicyStoreError';
  }
}

export type CodecSource =
  | 'invalid_document'
  | 'invalid_policy_input'
  | 'invalid_connection_input'
  | 'invalid_credential_input';

export function codecError(source: CodecSource, message: string): RuntimePolicyStoreError {
  return new RuntimePolicyStoreError(source, message);
}

export function decodePolicyInput<T>(decode: () => T): T {
  return mapDomainError(decode, 'invalid_policy_input');
}

export function decodeConnectionInput<T>(decode: () => T): T {
  return mapDomainError(decode, 'invalid_connection_input');
}

export function decodeCredentialInput<T>(decode: () => T): T {
  return mapDomainError(decode, 'invalid_credential_input');
}

export function decodePersistedDomain<T>(decode: () => T): T {
  return mapDomainError(decode, 'invalid_document');
}

export function invalidDocument(message: string, cause?: unknown): RuntimePolicyStoreError {
  return new RuntimePolicyStoreError(
    'invalid_document',
    message,
    cause === undefined ? undefined : { cause },
  );
}

export function ioFailed(message: string, cause: unknown): RuntimePolicyStoreError {
  return new RuntimePolicyStoreError('io_failed', message, { cause });
}

export function commitOutcomeUnknown(message: string, cause: unknown): RuntimePolicyStoreError {
  return new RuntimePolicyStoreError('commit_outcome_unknown', message, { cause });
}

function mapDomainError<T>(decode: () => T, code: CodecSource): T {
  try {
    return decode();
  } catch (error) {
    if (error instanceof RuntimePolicyDomainDecodeError) {
      throw new RuntimePolicyStoreError(code, error.message, { cause: error });
    }
    throw error;
  }
}
