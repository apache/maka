import type { ClientCapabilityConnectionIdentity } from '../../server/client-capability-service.js';

export function clientCapabilityConnectionIdentity(
  connectionId: string,
  clientInstanceId = connectionId,
  principalId = 'test-principal',
): ClientCapabilityConnectionIdentity {
  return { connectionId, principalId, clientInstanceId };
}
