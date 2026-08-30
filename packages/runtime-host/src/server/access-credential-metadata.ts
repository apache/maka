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

import { join } from 'node:path';
import { runtimeHostAccessCredentialFingerprintFromHash } from '../access-credential-identity.js';
import {
  discoverMarkedStorageRoot,
  resolveExistingStorageRootControlDirectory,
  resolveExistingStorageRoot,
} from '@maka/storage/root-authority';
import type { OperationKey } from '../protocol/index.js';
import { ACCESS_FILE_NAME, readAccessCredentialFile } from './access-credential-store.js';

export interface RuntimeHostAccessCredentialMetadata {
  readonly credentialId: string;
  readonly credentialFingerprint: string;
  readonly principalKind: 'remote_owner' | 'capability_provider';
  readonly principalId: string;
  readonly status: 'active' | 'pending';
  readonly operationGrants: readonly OperationKey[];
  readonly canPublishClientCapabilities: boolean;
  readonly canUseHostPaths: boolean;
  readonly createdAt: string;
  readonly expiresAt?: string;
}

export async function readRuntimeHostAccessCredentialMetadata(
  rootPath: string,
  expectedRootId?: string,
): Promise<{ readonly credentials: readonly RuntimeHostAccessCredentialMetadata[] }> {
  const capability = expectedRootId
    ? await resolveExistingStorageRoot({
        path: rootPath,
        kind: 'interactive',
        expectedRootId,
      })
    : await discoverMarkedStorageRoot({ path: rootPath });
  const { controlDirectory } = await resolveExistingStorageRootControlDirectory(capability);
  const file = await readAccessCredentialFile(join(controlDirectory, ACCESS_FILE_NAME));
  const now = Date.now();
  return {
    credentials: file.credentials.flatMap((credential) => {
      if (
        credential.principalKind === 'session_guest' ||
        (credential.status !== 'active' &&
          !(credential.status === 'pending' && Date.parse(credential.expiresAt!) > now))
      ) {
        return [];
      }
      return [
        {
          credentialId: credential.credentialId,
          credentialFingerprint: runtimeHostAccessCredentialFingerprintFromHash(
            credential.credentialHash,
          ),
          principalKind: credential.principalKind,
          principalId: credential.principalId,
          status: credential.status,
          operationGrants: credential.operationGrants,
          canPublishClientCapabilities: credential.canPublishClientCapabilities,
          canUseHostPaths: credential.canUseHostPaths,
          createdAt: credential.createdAt,
          ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
        },
      ];
    }),
  };
}
