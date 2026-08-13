import {
  connectExistingRuntimeHost,
  consumeAccessCredentialDelivery,
} from '@maka/runtime-host/client';
import {
  isOperationKey,
  REMOTE_OWNER_OPERATION_GRANTS,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type AccessCredentialPrincipalKind,
  type OperationKey,
} from '@maka/runtime-host/protocol';

const PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;

export interface RuntimeHostAccessIssueOptions {
  readonly rootPath: string;
  readonly principalKind: AccessCredentialPrincipalKind;
  readonly principalId: string;
  readonly operationGrants: readonly string[];
  readonly canPublishClientCapabilities: boolean;
  readonly canUseHostPaths: boolean;
  readonly preset?: RuntimeHostAccessPreset;
}

export type RuntimeHostAccessPreset = 'desktop-client' | 'terminal-client';

export interface ResolvedRuntimeHostAccessIssue {
  readonly principalKind: AccessCredentialPrincipalKind;
  readonly operationGrants: readonly OperationKey[];
  readonly canPublishClientCapabilities: boolean;
  readonly canUseHostPaths: boolean;
}

const CLIENT_CAPABILITY_PUBLICATION_OPERATIONS = new Set<OperationKey>([
  'client.capability.replace',
  'client.capability.unregister',
]);

export interface RuntimeHostAccessRevokeOptions {
  readonly rootPath: string;
  readonly credentialId: string;
}

export async function runRuntimeHostAccessIssueCli(
  options: RuntimeHostAccessIssueOptions,
): Promise<number> {
  const resolved = resolveRuntimeHostAccessIssue(options);
  const connection = await connectLocalOwner(options.rootPath);
  try {
    const result = await connection.request('access.credential.issue', {
      principalKind: resolved.principalKind,
      principalId: options.principalId,
      operationGrants: resolved.operationGrants,
      canPublishClientCapabilities: resolved.canPublishClientCapabilities,
      canUseHostPaths: resolved.canUseHostPaths,
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

export function resolveRuntimeHostAccessIssue(
  options: RuntimeHostAccessIssueOptions,
): ResolvedRuntimeHostAccessIssue {
  if (!options.preset) {
    return {
      principalKind: options.principalKind,
      operationGrants: requireOperationGrants(options.operationGrants),
      canPublishClientCapabilities: options.canPublishClientCapabilities,
      canUseHostPaths: options.canUseHostPaths,
    };
  }
  const canPublishClientCapabilities = options.preset === 'desktop-client';
  const operationGrants = REMOTE_OWNER_OPERATION_GRANTS.filter(
    (operation) =>
      canPublishClientCapabilities || !CLIENT_CAPABILITY_PUBLICATION_OPERATIONS.has(operation),
  );
  return {
    principalKind: 'remote_owner',
    operationGrants,
    canPublishClientCapabilities,
    canUseHostPaths: false,
  };
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
