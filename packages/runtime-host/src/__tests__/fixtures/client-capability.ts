import type { ClientCapabilityConnectionIdentity } from '../../server/client-capability-service.js';

export function clientCapabilityConnectionIdentity(
  connectionId: string,
  clientInstanceId = connectionId,
  principalId = 'test-principal',
  principalKind: ClientCapabilityConnectionIdentity['principalKind'] = 'local_owner',
): ClientCapabilityConnectionIdentity {
  return { connectionId, principalId, clientInstanceId, principalKind };
}
