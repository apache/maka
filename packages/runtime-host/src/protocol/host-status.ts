import { invalidProtocolFrame } from './errors.js';
import {
  requireCount,
  requireEncodedByteLimit,
  requireExactRecord,
  requireId,
  requireRecord,
  requireString,
  requireUtf8String,
} from './codec.js';
import { defineOperation } from './operation-spec.js';

export type HostLifecycleState = 'starting' | 'containing' | 'recovering' | 'ready' | 'draining';
export type HostStatusInput = Record<string, never>;
export type HostDiagnosticsInput = Record<string, never>;
export interface HostActivitySnapshot {
  readonly connections: number;
  readonly activeOperations: number;
  readonly processUptimeSeconds: number;
  readonly residencies: readonly { readonly label: string; readonly count: number }[];
}

export interface HostUpgradePrepareInput {
  readonly expectedHostEpoch: string;
  readonly allowInterruptActiveTasks: boolean;
}

export type HostUpgradePrepareResult =
  | { readonly kind: 'active_tasks' }
  | { readonly kind: 'prepared'; readonly pid: number };

export const HOST_DIAGNOSTICS_RESULT_MAX_BYTES = 72 * 1024;
export const HOST_DIAGNOSTIC_LOG_MAX_ENTRIES = 256;
export const HOST_DIAGNOSTIC_LOG_MAX_ENTRY_BYTES = 10 * 1024;

export interface HostStatusResult {
  hostEpoch: string;
  compositionId: string;
  compositionRevision: string;
  state: HostLifecycleState;
  connections: number;
  activeOperations: number;
  activeResidencies: number;
}

export interface HostDiagnosticsResult extends HostStatusResult {
  compositionModules: readonly string[];
  residencies: readonly { label: string; count: number }[];
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
  'host.upgrade.prepare': defineOperation({
    mode: 'command',
    availability: 'ready',
    errors: ['operation_conflict', 'operation_unavailable', 'internal_failure'] as const,
    decodeInput: decodeHostUpgradePrepareInput,
    decodeOutput: decodeHostUpgradePrepareResult,
  }),
} as const;

function decodeEmptyHostInput(value: unknown, label: string): HostStatusInput {
  requireExactRecord(value, label, []);
  return {};
}

function decodeHostStatusResult(value: unknown): HostStatusResult {
  const record = requireExactRecord(value, 'host.status result', [
    'hostEpoch',
    'compositionId',
    'compositionRevision',
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
    'compositionId',
    'compositionRevision',
    'state',
    'connections',
    'activeOperations',
    'activeResidencies',
    'compositionModules',
    'residencies',
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
  if (!Array.isArray(record.compositionModules) || record.compositionModules.length > 64) {
    throw invalidProtocolFrame('Invalid Runtime Host composition modules');
  }
  if (!Array.isArray(record.residencies) || record.residencies.length > 128) {
    throw invalidProtocolFrame('Invalid Runtime Host residencies');
  }
  return {
    ...decodeHostStatusFields(record),
    compositionModules: record.compositionModules.map((moduleId) =>
      requireString(moduleId, 'Runtime Host composition module id', 64),
    ),
    residencies: record.residencies.map((value) => {
      const residency = requireExactRecord(value, 'Runtime Host residency', ['label', 'count']);
      return {
        label: requireString(residency.label, 'Runtime Host residency label', 128),
        count: requireCount(residency.count, 'Runtime Host residency count'),
      };
    }),
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

export function decodeHostActivitySnapshot(value: unknown): HostActivitySnapshot {
  const record = requireExactRecord(value, 'Runtime Host activity', [
    'connections',
    'activeOperations',
    'processUptimeSeconds',
    'residencies',
  ]);
  if (!Array.isArray(record.residencies) || record.residencies.length > 128) {
    throw invalidProtocolFrame('Invalid Runtime Host activity residencies');
  }
  return {
    connections: requireCount(record.connections, 'Runtime Host activity connections'),
    activeOperations: requireCount(
      record.activeOperations,
      'Runtime Host activity active operations',
    ),
    processUptimeSeconds: requireCount(
      record.processUptimeSeconds,
      'Runtime Host activity process uptime',
    ),
    residencies: record.residencies.map((value) => {
      const residency = requireExactRecord(value, 'Runtime Host activity residency', [
        'label',
        'count',
      ]);
      return {
        label: requireString(residency.label, 'Runtime Host activity residency label', 128),
        count: requireCount(residency.count, 'Runtime Host activity residency count'),
      };
    }),
  };
}

function decodeHostUpgradePrepareInput(value: unknown): HostUpgradePrepareInput {
  const record = requireExactRecord(value, 'Runtime Host upgrade prepare input', [
    'expectedHostEpoch',
    'allowInterruptActiveTasks',
  ]);
  return {
    expectedHostEpoch: requireId(record.expectedHostEpoch, 'Runtime Host expected Host Epoch'),
    allowInterruptActiveTasks: requireBoolean(
      record.allowInterruptActiveTasks,
      'Runtime Host upgrade interrupt authority',
    ),
  };
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalidProtocolFrame(`Invalid ${label}`);
  return value;
}

function decodeHostUpgradePrepareResult(value: unknown): HostUpgradePrepareResult {
  const result = requireRecord(value, 'Runtime Host upgrade prepare result');
  if (result.kind === 'active_tasks') {
    requireExactRecord(value, 'Runtime Host upgrade prepare result', ['kind']);
    return { kind: 'active_tasks' };
  }
  if (result.kind !== 'prepared')
    throw invalidProtocolFrame('Invalid Runtime Host upgrade prepare result kind');
  const record = requireExactRecord(value, 'Runtime Host upgrade prepare result', ['kind', 'pid']);
  const pid = requireCount(record.pid, 'Runtime Host upgrade process id');
  if (pid === 0) throw invalidProtocolFrame('Invalid Runtime Host upgrade process id');
  return { kind: 'prepared', pid };
}

function decodeHostStatusFields(record: Record<string, unknown>): HostStatusResult {
  return {
    hostEpoch: requireId(record.hostEpoch, 'hostEpoch'),
    compositionId: requireString(record.compositionId, 'Runtime Host composition id', 128),
    compositionRevision: requireString(
      record.compositionRevision,
      'Runtime Host composition revision',
      128,
    ),
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
