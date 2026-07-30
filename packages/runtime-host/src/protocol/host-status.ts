import { invalidProtocolFrame } from './errors.js';
import { requireCount, requireExactRecord, requireId } from './codec.js';
import { defineOperation } from './operation-spec.js';

export type HostLifecycleState = 'starting' | 'containing' | 'recovering' | 'ready' | 'draining';
export type HostStatusInput = Record<string, never>;

export interface HostStatusResult {
  hostEpoch: string;
  state: HostLifecycleState;
  connections: number;
  activeOperations: number;
  activeResidencies: number;
}

export const HOST_STATUS_OPERATION_SPECS = {
  'host.status': defineOperation({
    mode: 'query',
    availability: 'bootstrap',
    errors: ['host_draining', 'internal_failure'] as const,
    decodeInput: decodeHostStatusInput,
    decodeOutput: decodeHostStatusResult,
  }),
} as const;

function decodeHostStatusInput(value: unknown): HostStatusInput {
  requireExactRecord(value, 'host.status input', []);
  return {};
}

function decodeHostStatusResult(value: unknown): HostStatusResult {
  const record = requireExactRecord(value, 'host.status result', [
    'hostEpoch',
    'state',
    'connections',
    'activeOperations',
    'activeResidencies',
  ]);
  return {
    hostEpoch: requireId(record.hostEpoch, 'hostEpoch'),
    state: requireHostLifecycleState(record.state),
    connections: requireCount(record.connections, 'connections'),
    activeOperations: requireCount(record.activeOperations, 'activeOperations'),
    activeResidencies: requireCount(record.activeResidencies, 'activeResidencies'),
  };
}

export function requireHostLifecycleState(value: unknown): HostLifecycleState {
  if (
    value === 'starting' ||
    value === 'containing' ||
    value === 'recovering' ||
    value === 'ready' ||
    value === 'draining'
  ) {
    return value;
  }
  throw invalidProtocolFrame('Invalid Host state');
}
