import { DiagnosticLogBuffer, truncateUtf8 } from '@maka/core/diagnostic-log';
import { installConsoleDiagnosticLogCapture } from '@maka/core/node-diagnostic-log';
import { redactSecrets } from '@maka/core/redaction';
import type { TurnTrace } from '@maka/core/session-trace';
import type { HostDiagnosticsResult } from '@maka/runtime-host/protocol';
import type {
  DesktopErrorDiagnosticInput,
  DesktopExecutionDiagnosticTarget,
} from '../preload/diagnostics-contract.js';

const INPUT_LIMITS = {
  title: 512,
  description: 24 * 1024,
  details: 24 * 1024,
  rendererUserAgent: 2 * 1024,
  rendererLocale: 64,
} as const;
const INPUT_TRUNCATION_MARKER = '\n<diagnostic input truncated>';

export interface DesktopDiagnosticEnvironment {
  readonly appVersion: string;
  readonly buildMode: 'dev' | 'packaged';
  readonly buildCommit: string | null;
  readonly electronVersion: string;
  readonly nodeVersion: string;
  readonly chromeVersion: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly osRelease: string;
  readonly locale: string;
  readonly workspacePath: string;
  readonly homePath: string;
  readonly processUptimeSeconds: number;
}

export type RuntimeHostDiagnosticRead =
  | { readonly ok: true; readonly value: HostDiagnosticsResult }
  | { readonly ok: false; readonly error: string };

export type RuntimeHostExecutionDiagnosticRead =
  | { readonly ok: true; readonly value: TurnTrace }
  | { readonly ok: false; readonly error: string };

export const mainProcessLogBuffer = new DiagnosticLogBuffer();

let logCaptureInstalled = false;

export function installMainProcessLogCapture(buffer: DiagnosticLogBuffer = mainProcessLogBuffer): void {
  if (logCaptureInstalled) return;
  logCaptureInstalled = true;
  installConsoleDiagnosticLogCapture(buffer);
}

export function parseDesktopErrorDiagnosticInput(input: unknown): DesktopErrorDiagnosticInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Invalid Desktop diagnostic input');
  }
  const record = input as Record<string, unknown>;
  const allowedKeys = new Set([
    'surface',
    'title',
    'description',
    'details',
    'execution',
    'rendererUserAgent',
    'rendererLocale',
  ]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new TypeError('Invalid Desktop diagnostic input');
  }
  if (record.surface !== 'toast' && record.surface !== 'renderer_crash') {
    throw new TypeError('Invalid Desktop diagnostic surface');
  }
  const title = requireDiagnosticString(record.title, 'title', INPUT_LIMITS.title);
  return {
    surface: record.surface,
    title,
    ...optionalBoundedString(record, 'description', INPUT_LIMITS.description),
    ...optionalBoundedString(record, 'details', INPUT_LIMITS.details),
    ...(record.execution !== undefined
      ? { execution: parseExecutionDiagnosticTarget(record.execution) }
      : {}),
    ...optionalBoundedString(record, 'rendererUserAgent', INPUT_LIMITS.rendererUserAgent),
    ...optionalBoundedString(record, 'rendererLocale', INPUT_LIMITS.rendererLocale),
  };
}

export function formatDesktopErrorDiagnosticReport(
  input: DesktopErrorDiagnosticInput,
  environment: DesktopDiagnosticEnvironment,
  mainLogs: readonly string[],
  runtimeHost: RuntimeHostDiagnosticRead,
  runtimeExecution: RuntimeHostExecutionDiagnosticRead | undefined = undefined,
  capturedAt = new Date(),
): string {
  const lines = [
    'Maka Desktop diagnostic report',
    `Captured at: ${capturedAt.toISOString()}`,
    '',
    'Error',
    `Surface: ${input.surface}`,
    `Title: ${input.title}`,
  ];
  if (input.description) lines.push(`Description: ${input.description}`);
  if (input.details) lines.push('', 'Details:', input.details);

  lines.push(
    '',
    'Environment',
    `Maka: ${environment.appVersion}`,
    `Build: ${environment.buildMode}${environment.buildCommit ? ` @ ${environment.buildCommit.slice(0, 12)}` : ''}`,
    `Electron: ${environment.electronVersion}`,
    `Chrome: ${environment.chromeVersion}`,
    `Node: ${environment.nodeVersion}`,
    `OS: ${environment.platform} ${environment.osRelease} (${environment.arch})`,
    `Locale: ${environment.locale}`,
    `Renderer locale: ${input.rendererLocale ?? '<unknown>'}`,
    `Renderer user agent: ${input.rendererUserAgent ?? '<unknown>'}`,
    `Workspace: ${environment.workspacePath}`,
    `Main process uptime: ${Math.max(0, Math.floor(environment.processUptimeSeconds))}s`,
    '',
    `Recent main-process logs (${mainLogs.length})`,
    ...(mainLogs.length > 0 ? mainLogs : ['<none captured>']),
  );

  lines.push('', 'Runtime Host');
  if (runtimeHost.ok) {
    const host = runtimeHost.value;
    lines.push(
      `Epoch: ${host.hostEpoch}`,
      `Protocol: v${host.protocolVersion} · compatibility ${host.compatibilityEpoch}`,
      `State: ${host.state}`,
      `Process: ${host.pid} · uptime ${host.processUptimeSeconds}s`,
      `Runtime: Node ${host.nodeVersion} · ${host.platform} ${host.osRelease} (${host.arch})`,
      `Activity: ${host.connections} connections · ${host.activeOperations} operations · ${host.activeResidencies} residencies`,
      `Recent Runtime Host logs (${host.logs.length})`,
      ...(host.logs.length > 0 ? host.logs : ['<none captured>']),
    );
  } else {
    lines.push(`Diagnostics unavailable: ${runtimeHost.error}`);
  }

  if (input.execution) {
    lines.push('', 'Runtime Host execution');
    if (!runtimeExecution?.ok) {
      lines.push(`Execution evidence unavailable: ${runtimeExecution?.error ?? 'not queried'}`);
    } else {
      appendTurnTrace(lines, input.execution, runtimeExecution.value);
    }
  }

  const redacted = redactSecrets(lines.join('\n'));
  return collapseHomePath(redacted, environment.homePath, environment.platform);
}

function parseExecutionDiagnosticTarget(value: unknown): DesktopExecutionDiagnosticTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid Desktop execution diagnostic target');
  }
  const record = value as Record<string, unknown>;
  const keys = ['sessionId', 'turnId', 'eventId'] as const;
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new TypeError('Invalid Desktop execution diagnostic target');
  }
  return {
    sessionId: requireDiagnosticEntityId(record.sessionId, 'sessionId'),
    turnId: requireDiagnosticEntityId(record.turnId, 'turnId'),
    eventId: requireDiagnosticId(record.eventId, 'eventId'),
  };
}

function requireDiagnosticEntityId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError(`Invalid Desktop diagnostic ${label}`);
  }
  return value;
}

function requireDiagnosticId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    Buffer.byteLength(value, 'utf8') > 512
  ) {
    throw new TypeError(`Invalid Desktop diagnostic ${label}`);
  }
  return value;
}

function appendTurnTrace(
  lines: string[],
  target: DesktopExecutionDiagnosticTarget,
  turn: TurnTrace,
): void {
  if (turn.turnId !== target.turnId) {
    lines.push('Execution evidence unavailable: Turn identity did not match');
    return;
  }
  lines.push(
    `Session: ${target.sessionId}`,
    `Turn: ${target.turnId}`,
    `Run: ${turn.runId}`,
    `Event: ${target.eventId}`,
    `Duration: ${turn.durationMs}ms`,
  );
  if (turn.failure) {
    lines.push(`Failure: ${turn.failure.code}`);
    if (turn.failure.message) lines.push(`Failure message: ${turn.failure.message}`);
  }
  const calls = turn.steps.filter((step) => step.kind === 'model_call');
  lines.push(`Model calls (${calls.length})`);
  if (calls.length === 0) {
    lines.push('<none recorded>');
    return;
  }
  for (const call of calls) {
    lines.push(
      `- ${call.providerId}/${call.modelId} · ${call.status} · ${call.durationMs}ms · ${call.attempts.length} attempt(s)`,
    );
    for (const attempt of call.attempts) {
      lines.push(
        `  - ${attempt.attemptId} · ${attempt.status} · ${attempt.latencyMs}ms${attempt.errorClass ? ` · ${attempt.errorClass}` : ''}`,
      );
    }
  }
}

function optionalBoundedString(
  record: Record<string, unknown>,
  key: keyof typeof INPUT_LIMITS,
  maximum: number,
): Partial<Record<typeof key, string>> {
  const value = record[key];
  if (value === undefined) return {};
  return { [key]: requireDiagnosticString(value, key, maximum) };
}

function requireDiagnosticString(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`Invalid Desktop diagnostic ${label}`);
  }
  return truncateUtf8(value, maximumBytes, INPUT_TRUNCATION_MARKER);
}

function collapseHomePath(value: string, homePath: string, platform: NodeJS.Platform): string {
  if (!homePath) return value;
  const escaped = homePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return value.replace(new RegExp(escaped, platform === 'win32' ? 'gi' : 'g'), '~');
}
