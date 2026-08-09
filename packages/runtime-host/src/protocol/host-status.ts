import { invalidProtocolFrame } from './errors.js';
import {
  requireCount,
  requireEncodedByteLimit,
  requireExactRecord,
  requireId,
  requireString,
  requireUtf8String,
} from './codec.js';
import { defineOperation } from './operation-spec.js';

export type HostLifecycleState = 'starting' | 'containing' | 'recovering' | 'ready' | 'draining';
export type HostStatusInput = Record<string, never>;
export type HostDiagnosticsInput = Record<string, never>;

export const HOST_DIAGNOSTICS_RESULT_MAX_BYTES = 72 * 1024;
export const HOST_DIAGNOSTIC_LOG_MAX_ENTRIES = 256;
export const HOST_DIAGNOSTIC_LOG_MAX_ENTRY_BYTES = 10 * 1024;

export interface HostStatusResult {
  hostEpoch: string;
  state: HostLifecycleState;
  connections: number;
  activeOperations: number;
  activeResidencies: number;
}

export interface HostDiagnosticsResult extends HostStatusResult {
  protocolVersion: number;
  compatibilityEpoch: number;
  pid: number;
  processUptimeSeconds: number;
  nodeVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  osRelease: string;
  logs: readonly string[];
}

export const HOST_BOOTSTRAP_OPERATION_SPECS = {
  'host.status': defineOperation({
    mode: 'query',
    availability: 'bootstrap',
    errors: ['host_draining', 'internal_failure'] as const,
    decodeInput: (value) => decodeEmptyHostInput(value, 'host.status input'),
    decodeOutput: decodeHostStatusResult,
  }),
  'host.diagnostics.query': defineOperation({
    mode: 'query',
    availability: 'bootstrap',
    errors: ['host_draining', 'internal_failure'] as const,
    decodeInput: (value) => decodeEmptyHostInput(value, 'host.diagnostics.query input'),
    decodeOutput: decodeHostDiagnosticsResult,
  }),
} as const;

function decodeEmptyHostInput(value: unknown, label: string): HostStatusInput {
  requireExactRecord(value, label, []);
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
  return decodeHostStatusFields(record);
}

function decodeHostDiagnosticsResult(value: unknown): HostDiagnosticsResult {
  requireEncodedByteLimit(
    value,
    'host.diagnostics.query result',
    HOST_DIAGNOSTICS_RESULT_MAX_BYTES,
  );
  const record = requireExactRecord(value, 'host.diagnostics.query result', [
    'hostEpoch',
    'state',
    'connections',
    'activeOperations',
    'activeResidencies',
    'protocolVersion',
    'compatibilityEpoch',
    'pid',
    'processUptimeSeconds',
    'nodeVersion',
    'platform',
    'arch',
    'osRelease',
    'logs',
  ]);
  if (!Array.isArray(record.logs) || record.logs.length > HOST_DIAGNOSTIC_LOG_MAX_ENTRIES) {
    throw invalidProtocolFrame('Invalid Runtime Host diagnostic logs');
  }
  return {
    ...decodeHostStatusFields(record),
    protocolVersion: requireCount(record.protocolVersion, 'Runtime Host protocol version'),
    compatibilityEpoch: requireCount(record.compatibilityEpoch, 'Runtime Host compatibility epoch'),
    pid: requireCount(record.pid, 'Runtime Host pid'),
    processUptimeSeconds: requireCount(record.processUptimeSeconds, 'Runtime Host process uptime'),
    nodeVersion: requireString(record.nodeVersion, 'Runtime Host Node version', 64),
    platform: requirePlatform(record.platform),
    arch: requireString(record.arch, 'Runtime Host architecture', 64),
    osRelease: requireString(record.osRelease, 'Runtime Host OS release', 256),
    logs: record.logs.map((entry) =>
      requireUtf8String(
        entry,
        'Runtime Host diagnostic log entry',
        HOST_DIAGNOSTIC_LOG_MAX_ENTRY_BYTES,
      ),
    ),
  };
}

function decodeHostStatusFields(record: Record<string, unknown>): HostStatusResult {
  return {
    hostEpoch: requireId(record.hostEpoch, 'hostEpoch'),
    state: requireHostLifecycleState(record.state),
    connections: requireCount(record.connections, 'connections'),
    activeOperations: requireCount(record.activeOperations, 'activeOperations'),
    activeResidencies: requireCount(record.activeResidencies, 'activeResidencies'),
  };
}

function requirePlatform(value: unknown): NodeJS.Platform {
  if (
    value === 'aix' ||
    value === 'android' ||
    value === 'darwin' ||
    value === 'freebsd' ||
    value === 'haiku' ||
    value === 'linux' ||
    value === 'openbsd' ||
    value === 'sunos' ||
    value === 'win32' ||
    value === 'cygwin' ||
    value === 'netbsd'
  ) {
    return value;
  }
  throw invalidProtocolFrame('Invalid Runtime Host platform');
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
