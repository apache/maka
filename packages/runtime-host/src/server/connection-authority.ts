import {
  HOST_OPERATION_SPECS,
  operationAllowsRemoteOwner,
  operationUsesHostPaths,
  type AccessCredentialPrincipalKind,
  type ClientCapabilityClientFrame,
  type OperationKey,
  type RequestFrame,
} from '../protocol/index.js';

export interface RuntimeHostConnectionAuthority {
  readonly principalKind: 'local_owner' | AccessCredentialPrincipalKind;
  readonly principalId: string;
  readonly credentialId?: string;
  readonly operationGrants: 'all' | readonly OperationKey[];
  readonly canPublishClientCapabilities: boolean;
  readonly canUseHostPaths: boolean;
}

export const LOCAL_OWNER_CONNECTION_AUTHORITY = createRuntimeHostConnectionAuthority({
  principalKind: 'local_owner',
  principalId: 'local_os_user',
  operationGrants: 'all',
  canPublishClientCapabilities: true,
  canUseHostPaths: true,
});

export function createRuntimeHostConnectionAuthority(
  input: RuntimeHostConnectionAuthority,
): RuntimeHostConnectionAuthority {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(input.principalId)) {
    throw new Error('Runtime Host connection principal is invalid');
  }
  if (
    input.principalKind !== 'local_owner' &&
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.credentialId ?? '')
  ) {
    throw new Error('Runtime Host access credential identity is invalid');
  }
  const operationGrants =
    input.operationGrants === 'all'
      ? 'all'
      : Object.freeze(
          [...new Set(input.operationGrants)].map((operation) => {
            if (!Object.hasOwn(HOST_OPERATION_SPECS, operation)) {
              throw new Error(`Unknown Runtime Host operation grant: ${operation}`);
            }
            return operation;
          }),
        );
  return Object.freeze({ ...input, operationGrants });
}

export function authorizeRuntimeHostOperation(
  authority: RuntimeHostConnectionAuthority,
  frame: RequestFrame,
): boolean {
  if (authority.principalKind !== 'local_owner' && !operationAllowsRemoteOwner(frame.operation)) {
    return false;
  }
  if (authority.operationGrants !== 'all' && !authority.operationGrants.includes(frame.operation)) {
    return false;
  }
  if (
    (frame.operation === 'client.capability.replace' ||
      frame.operation === 'client.capability.unregister') &&
    !authority.canPublishClientCapabilities
  ) {
    return false;
  }
  return authority.canUseHostPaths || !operationUsesHostPaths(frame);
}

export function hasRuntimeHostOperationGrant(
  authority: RuntimeHostConnectionAuthority,
  operation: OperationKey,
): boolean {
  return authority.operationGrants === 'all' || authority.operationGrants.includes(operation);
}

export function authorizeClientCapabilityFrame(
  authority: RuntimeHostConnectionAuthority,
  _frame: ClientCapabilityClientFrame,
): boolean {
  return authority.canPublishClientCapabilities;
}
