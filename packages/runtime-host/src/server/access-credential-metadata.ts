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
        credential.status !== 'active' &&
        !(credential.status === 'pending' && Date.parse(credential.expiresAt!) > now)
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
