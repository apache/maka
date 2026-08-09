import { HOST_OPERATION_SPECS, type OperationKey } from '../protocol/index.js';

export interface RuntimeHostConnectionAuthority {
  readonly principalKind: 'local_owner' | 'access_credential';
  readonly principalId: string;
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
