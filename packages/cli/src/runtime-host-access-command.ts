import {
  connectExistingRuntimeHost,
  consumeAccessCredentialDelivery,
} from '@maka/runtime-host/client';
import {
  isOperationKey,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type OperationKey,
} from '@maka/runtime-host/protocol';

const PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;

export interface RuntimeHostAccessIssueOptions {
  readonly rootPath: string;
  readonly principalId: string;
  readonly operationGrants: readonly string[];
  readonly canPublishClientCapabilities: boolean;
  readonly canUseHostPaths: boolean;
}

export interface RuntimeHostAccessRevokeOptions {
  readonly rootPath: string;
  readonly credentialId: string;
}

export async function runRuntimeHostAccessIssueCli(
  options: RuntimeHostAccessIssueOptions,
): Promise<number> {
  const operationGrants = requireOperationGrants(options.operationGrants);
  const connection = await connectLocalOwner(options.rootPath);
  try {
    const result = await connection.request('access.credential.issue', {
      principalId: options.principalId,
      operationGrants,
      canPublishClientCapabilities: options.canPublishClientCapabilities,
      canUseHostPaths: options.canUseHostPaths,
    });
    const credential = await consumeAccessCredentialDelivery(
      options.rootPath,
      result.deliveryId,
      result.credentialId,
    );
    const { deliveryId: _deliveryId, ...metadata } = result;
    process.stdout.write(`${JSON.stringify({ ...metadata, credential }, null, 2)}\n`);
    return 0;
  } finally {
    await connection.close();
  }
}

export async function runRuntimeHostAccessRevokeCli(
  options: RuntimeHostAccessRevokeOptions,
): Promise<number> {
  const connection = await connectLocalOwner(options.rootPath);
  try {
    const result = await connection.request('access.credential.revoke', {
      credentialId: options.credentialId,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.revoked ? 0 : 1;
  } finally {
    await connection.close();
  }
}

async function connectLocalOwner(rootPath: string) {
  const result = await connectExistingRuntimeHost({
    rootPath,
    surface: 'run',
    protocol: PROTOCOL,
  });
  if (result.kind !== 'connected') {
    throw new Error(`Runtime Host service is not available (${result.kind})`);
  }
  return result.connection;
}

function requireOperationGrants(values: readonly string[]): readonly OperationKey[] {
  const grants = values.flatMap((value) => value.split(',')).filter((value) => value.length > 0);
  if (grants.length === 0) throw new Error('At least one --grant is required');
  for (const grant of grants) {
    if (!isOperationKey(grant)) throw new Error(`Unknown Runtime Host operation grant: ${grant}`);
  }
  return [...new Set(grants)] as OperationKey[];
}
