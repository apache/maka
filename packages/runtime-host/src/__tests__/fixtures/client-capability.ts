import type { ClientCapabilityConnectionIdentity } from '../../server/client-capability-service.js';

export function clientCapabilityConnectionIdentity(
  connectionId: string,
  clientInstanceId = connectionId,
  principalId = 'test-principal',
  unattended = false,
): ClientCapabilityConnectionIdentity {
  return { connectionId, principalId, clientInstanceId, unattended };
}
