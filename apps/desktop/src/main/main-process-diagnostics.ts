/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { collapseHomePath, DiagnosticLogBuffer, truncateUtf8 } from '@maka/core/diagnostic-log';
import { installConsoleDiagnosticLogCapture } from '@maka/core/node-diagnostic-log';
import { redactSecrets } from '@maka/core/redaction';
import type { TurnTrace } from '@maka/core/session-trace';
import type { HostDiagnosticsResult } from '@maka/runtime-host/protocol';
import { arch as osArch, homedir, release as osRelease } from 'node:os';
import type {
  DesktopDiagnosticWireInput,
  DesktopExecutionDiagnosticTarget,
} from '../preload/diagnostics-contract.js';
import {
  requireDesktopTargetScope,
  type DesktopTargetScope,
} from '../shared/runtime-host-identity.js';

const INPUT_LIMITS = {
  title: 512,
  description: 24 * 1024,
  details: 24 * 1024,
  rendererUserAgent: 2 * 1024,
  rendererLocale: 64,
} as const;
const INPUT_TRUNCATION_MARKER = '\n<diagnostic input truncated>';
const EXECUTION_DIAGNOSTIC_TIMEOUT_MS = 2_000;
export const MAIN_PROCESS_DIAGNOSTIC_LOG_MAX_BYTES = 256 * 1024;

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

export interface DesktopDiagnosticEnvironmentSource {
  readonly appVersion: string;
  readonly buildMode: 'dev' | 'packaged';
  readonly buildCommit: string | null;
  readonly locale: string;
  readonly workspacePath: string;
}

export interface DesktopStartupDiagnosticInput {
  readonly surface: 'startup';
  readonly title: string;
  readonly description?: string;
  readonly details?: string;
  readonly hostTarget: 'none';
}

export type DesktopDiagnosticReportInput =
  | DesktopDiagnosticWireInput
  | DesktopStartupDiagnosticInput;

export type RuntimeHostDiagnosticRead =
  | { readonly ok: true; readonly value: HostDiagnosticsResult }
  | { readonly ok: false; readonly error: string };

export type RuntimeHostExecutionDiagnosticRead =
  | { readonly ok: true; readonly value: TurnTrace }
  | { readonly ok: false; readonly error: string };

type RuntimeHostDiagnosticsClient = {
  readonly getDiagnostics: () => Promise<HostDiagnosticsResult>;
  readonly getTurnTrace: (
    sessionId: string,
    turnId: string,
    timeoutMs: number,
  ) => Promise<TurnTrace | undefined>;
};

export interface DesktopDiagnosticsDeps {
  readonly environment: () => DesktopDiagnosticEnvironment;
  readonly mainLogs: () => readonly string[];
  readonly resolveActiveRuntimeHost: () => RuntimeHostDiagnosticsClient | undefined;
  readonly resolveRuntimeHost: (scope: DesktopTargetScope) => RuntimeHostDiagnosticsClient | undefined;
  readonly writeClipboard: (value: string) => void;
}

export const mainProcessLogBuffer = new DiagnosticLogBuffer({
  maxBytes: MAIN_PROCESS_DIAGNOSTIC_LOG_MAX_BYTES,
});

let logCaptureInstalled = false;

export function installMainProcessLogCapture(buffer: DiagnosticLogBuffer = mainProcessLogBuffer): void {
  if (logCaptureInstalled) return;
  logCaptureInstalled = true;
  installConsoleDiagnosticLogCapture(buffer);
}

export function captureDesktopDiagnosticEnvironment(
  source: DesktopDiagnosticEnvironmentSource,
): DesktopDiagnosticEnvironment {
  return {
    ...source,
    electronVersion: process.versions.electron ?? '',
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome ?? '',
    platform: process.platform,
    arch: osArch(),
    osRelease: osRelease(),
    homePath: homedir(),
    processUptimeSeconds: process.uptime(),
  };
}

export function createDesktopStartupDiagnosticInput(input: {
  readonly title: string;
  readonly description?: string;
  readonly details?: string;
}): DesktopStartupDiagnosticInput {
  return {
    surface: 'startup',
    hostTarget: 'none',
    title: requireDiagnosticString(input.title, 'title', INPUT_LIMITS.title),
    ...(input.description
      ? {
          description: requireDiagnosticString(
            input.description,
            'description',
            INPUT_LIMITS.description,
          ),
        }
      : {}),
    ...(input.details
      ? { details: requireDiagnosticString(input.details, 'details', INPUT_LIMITS.details) }
      : {}),
  };
}

export function parseDesktopDiagnosticInput(input: unknown): DesktopDiagnosticWireInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Invalid Desktop diagnostic input');
  }
  const record = input as Record<string, unknown>;
  const sharedKeys = new Set([
    'surface',
    'hostTarget',
    'rendererUserAgent',
    'rendererLocale',
  ]);
  if (record.surface === 'manual') {
    if (Object.keys(record).some((key) => !sharedKeys.has(key))) {
      throw new TypeError('Invalid Desktop diagnostic input');
    }
    return {
      surface: 'manual',
      hostTarget: parseManualDiagnosticHostTarget(record.hostTarget),
      ...optionalBoundedString(record, 'rendererUserAgent', INPUT_LIMITS.rendererUserAgent),
      ...optionalBoundedString(record, 'rendererLocale', INPUT_LIMITS.rendererLocale),
    };
  }
  if (record.surface !== 'toast' && record.surface !== 'renderer_crash') {
    throw new TypeError('Invalid Desktop diagnostic surface');
  }
  const allowedKeys = new Set([
    ...sharedKeys,
    'title',
    'description',
    'details',
    ...(record.surface === 'toast' ? ['execution'] : []),
  ]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new TypeError('Invalid Desktop diagnostic input');
  }
  const title = requireDiagnosticString(record.title, 'title', INPUT_LIMITS.title);
  const errorDetails = {
    title,
    ...optionalBoundedString(record, 'description', INPUT_LIMITS.description),
    ...optionalBoundedString(record, 'details', INPUT_LIMITS.details),
    ...optionalBoundedString(record, 'rendererUserAgent', INPUT_LIMITS.rendererUserAgent),
    ...optionalBoundedString(record, 'rendererLocale', INPUT_LIMITS.rendererLocale),
  };
  if (record.surface === 'renderer_crash') {
    if (record.hostTarget !== 'none') {
      throw new TypeError('Renderer crash diagnostics cannot target a Runtime Host');
    }
    return {
      surface: 'renderer_crash',
      hostTarget: 'none',
      ...errorDetails,
    };
  }
  if (record.hostTarget !== 'none' && record.hostTarget !== 'task') {
    throw new TypeError('Toast diagnostics require an explicit Runtime Host target');
  }
  if (record.hostTarget === 'none') {
    if (record.execution !== undefined) {
      throw new TypeError('Desktop-only diagnostics cannot carry Runtime Host execution');
    }
    return {
      surface: 'toast',
      hostTarget: 'none',
      ...errorDetails,
    };
  }
  return {
    surface: 'toast',
    hostTarget: 'task',
    ...errorDetails,
    ...(record.execution !== undefined
      ? { execution: parseExecutionDiagnosticTarget(record.execution) }
      : {}),
  };
}

export async function copyDesktopDiagnosticReport(
  deps: DesktopDiagnosticsDeps,
  input: DesktopDiagnosticReportInput,
  scope: unknown = undefined,
): Promise<void> {
  let runtime: RuntimeHostDiagnosticsClient | undefined;
  if (input.hostTarget === 'none') {
    if (scope !== undefined) {
      throw new Error('Desktop-only diagnostics must not carry a Host scope');
    }
  } else if (input.hostTarget === 'default') {
    if (scope !== undefined) {
      throw new Error('Default Desktop diagnostics must not carry a Host scope');
    }
    try {
      runtime = deps.resolveActiveRuntimeHost();
    } catch {
      runtime = undefined;
    }
  } else if (scope !== undefined) {
    const target = requireDesktopTargetScope(scope);
    try {
      runtime = deps.resolveRuntimeHost(target);
    } catch {
      // A task's Host may disappear between preload scope resolution and
      // this capture. The Desktop report remains useful on its own.
      runtime = undefined;
    }
  }
  let runtimeHost: RuntimeHostDiagnosticRead;
  if (!runtime) {
    let error: string;
    if (input.hostTarget === 'none') {
      error = input.surface === 'startup'
        ? 'Runtime Host diagnostics were unavailable before the app opened'
        : 'No Runtime Host authority was associated with this error';
    } else if (input.hostTarget === 'default') {
      error = input.surface === 'manual'
        ? 'Runtime Host is unavailable'
        : 'Runtime Host is reconnecting';
    } else {
      error = input.surface !== 'manual' && scope !== undefined
        ? 'Runtime Host is reconnecting'
        : 'Runtime Host for this task is unavailable';
    }
    runtimeHost = { ok: false, error };
  } else {
    try {
      runtimeHost = { ok: true, value: await runtime.getDiagnostics() };
    } catch (error) {
      runtimeHost = {
        ok: false,
        error: boundedDiagnosticError(error),
      };
    }
  }
  let runtimeExecution: RuntimeHostExecutionDiagnosticRead | undefined;
  const execution = input.surface === 'toast' ? input.execution : undefined;
  if (execution && runtime) {
    try {
      const turn = await runtime.getTurnTrace(
        execution.sessionId,
        execution.turnId,
        EXECUTION_DIAGNOSTIC_TIMEOUT_MS,
      );
      runtimeExecution = turn
        ? { ok: true, value: turn }
        : { ok: false, error: 'Execution evidence was not found' };
    } catch (error) {
      runtimeExecution = {
        ok: false,
        error: boundedDiagnosticError(error),
      };
    }
  }
  deps.writeClipboard(
    formatDesktopDiagnosticReport(
      input,
      deps.environment(),
      deps.mainLogs(),
      runtimeHost,
      runtimeExecution,
    ),
  );
}

export function formatDesktopDiagnosticReport(
  input: DesktopDiagnosticReportInput,
  environment: DesktopDiagnosticEnvironment,
  mainLogs: readonly string[],
  runtimeHost: RuntimeHostDiagnosticRead,
  runtimeExecution: RuntimeHostExecutionDiagnosticRead | undefined = undefined,
  capturedAt = new Date(),
): string {
  const lines = ['Maka Desktop diagnostic report', `Captured at: ${capturedAt.toISOString()}`];
  const rendererContext = input.surface === 'startup' ? undefined : input;
  if (input.surface === 'manual') {
    lines.push('', 'Capture', 'Surface: manual');
  } else {
    lines.push('', 'Error', `Surface: ${input.surface}`, `Title: ${input.title}`);
    if (input.description) lines.push(`Description: ${input.description}`);
    if (input.details) lines.push('', 'Details:', input.details);
  }

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
    `Renderer locale: ${rendererContext?.rendererLocale ?? '<unknown>'}`,
    `Renderer user agent: ${rendererContext?.rendererUserAgent ?? '<unknown>'}`,
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

  const execution = input.surface === 'toast' ? input.execution : undefined;
  if (execution) {
    lines.push('', 'Runtime Host execution');
    if (!runtimeExecution?.ok) {
      lines.push(`Execution evidence unavailable: ${runtimeExecution?.error ?? 'not queried'}`);
    } else {
      appendTurnTrace(lines, execution, runtimeExecution.value);
    }
  }

  const redacted = redactSecrets(lines.join('\n'));
  return collapseHomePath(redacted, environment.homePath, environment.platform);
}

function parseManualDiagnosticHostTarget(
  value: unknown,
): 'default' | 'task' {
  if (value === 'default' || value === 'task') return value;
  if (value === 'none') {
    throw new TypeError('Manual Desktop diagnostics require Runtime Host authority');
  }
  throw new TypeError('Invalid Desktop diagnostic Runtime Host target');
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
    if (turn.failure.attributedToStepId) {
      lines.push(`Failure step: ${turn.failure.attributedToStepId}`);
    }
  }
  lines.push(`Steps (${turn.steps.length})`);
  if (turn.steps.length === 0) {
    lines.push('<none recorded>');
    return;
  }
  for (const step of turn.steps) {
    switch (step.kind) {
      case 'model_call':
        lines.push(
          `- [${step.id}] model ${step.callKind} · ${step.providerId}/${step.modelId} · ${step.status} · ${step.durationMs}ms · ${step.attempts.length} attempt(s)`,
        );
        for (const attempt of step.attempts) {
          const details = [
            attempt.errorClass,
            attempt.httpStatus === undefined ? undefined : `HTTP ${attempt.httpStatus}`,
            attempt.providerCode === undefined ? undefined : `provider ${attempt.providerCode}`,
            attempt.providerRequestId === undefined
              ? undefined
              : `request ${attempt.providerRequestId}`,
            attempt.retryable === undefined ? undefined : `retryable ${attempt.retryable}`,
          ].filter((detail): detail is string => detail !== undefined);
          lines.push(
            `  - ${attempt.attemptId} · ${attempt.status} · ${attempt.latencyMs}ms${details.length > 0 ? ` · ${details.join(' · ')}` : ''}`,
          );
        }
        break;
      case 'tool':
        lines.push(
          `- [${step.id}] tool ${step.toolName} · ${step.status}${step.durationMs === undefined ? '' : ` · ${step.durationMs}ms`}${step.recoveryPolicy ? ` · recovery ${step.recoveryPolicy}` : ''}${step.recovered ? ` · ${step.recovered.disposition} (${step.recovered.reasonCode})` : ''}`,
        );
        break;
      case 'permission':
        lines.push(
          `- [${step.id}] permission${step.toolName ? ` ${step.toolName}` : ''} · ${step.decision}`,
        );
        break;
      case 'compaction':
        lines.push(
          `- [${step.id}] compaction${step.checkpointId ? ` · checkpoint ${step.checkpointId}` : ''}`,
        );
        break;
      case 'error':
        lines.push(`- [${step.id}] error · ${step.message}`);
        break;
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

function boundedDiagnosticError(error: unknown): string {
  return truncateUtf8(
    redactSecrets(error instanceof Error ? error.message : String(error)),
    1024,
  );
}
