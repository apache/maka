import { DiagnosticLogBuffer, truncateUtf8 } from '@maka/core/diagnostic-log';
import { installConsoleDiagnosticLogCapture } from '@maka/core/node-diagnostic-log';
import { redactSecrets } from '@maka/core/redaction';
import type { HostDiagnosticsResult } from '@maka/runtime-host/protocol';
import type { DesktopErrorDiagnosticInput } from '../preload/diagnostics-contract.js';

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
    ...optionalBoundedString(record, 'rendererUserAgent', INPUT_LIMITS.rendererUserAgent),
    ...optionalBoundedString(record, 'rendererLocale', INPUT_LIMITS.rendererLocale),
  };
}

export function formatDesktopErrorDiagnosticReport(
  input: DesktopErrorDiagnosticInput,
  environment: DesktopDiagnosticEnvironment,
  mainLogs: readonly string[],
  runtimeHost: RuntimeHostDiagnosticRead,
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

  const redacted = redactSecrets(lines.join('\n'));
  return collapseHomePath(redacted, environment.homePath, environment.platform);
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
