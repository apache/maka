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

import { randomUUID } from 'node:crypto';
import { mkdir, realpath, stat, readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { SessionEvent } from '@maka/core/events';
import type { PermissionMode } from '@maka/core/permission';
import type { CreateSessionInput, UserMessageInput } from '@maka/core/runtime-inputs';
import type { SessionSummary } from '@maka/core/session';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { redactSecrets } from '@maka/core/redaction';
import { assertSessionBundleRootLayout } from '@maka/storage';
import { readRuntimeHostSessions } from '@maka/runtime-host/client';
import { connectRuntimeHostCli, resolveRuntimeHostCliTarget } from './runtime-host-cli-context.js';
import { createRuntimeHostRunContext } from './runtime-host-run-command.js';
import { runtimeHostSessionSummary } from './runtime-host-session-driver.js';
import type { MakaRunOutcome } from './run-command-core.js';
import { sessionEventSandboxBoundaryFailureReason } from './sandbox-boundary-failure.js';

const PROTOCOL = 'maka.activation' as const;
const SCHEMA_VERSION = 1 as const;
const MAX_RUNTIME_EVENTS = 256;
const MAX_RUNTIME_EVENT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const ACTIVATION_STIMULUS_TYPES = new Set(['message', 'schedule', 'system']);

export type MakaActivationStatus = 'completed' | 'blocked' | 'retryable_failure' | 'fatal_failure';

export type MakaActivationBlockedReason = 'permission_denied' | 'permission_required';
export type MakaActivationRequiredAction = 'grant_permission' | 'retry_activation';

export interface MakaActivationOptions {
  stateRoot: string;
  workspaceRoot: string;
  configRoot: string;
  input: string;
  timeoutMs?: number;
  maxSteps?: number;
  permissionMode?: Exclude<PermissionMode, 'ask'>;
  connection?: string;
  model?: string;
}

export type ParseMakaActivateArgsResult =
  | { kind: 'activate'; options: MakaActivationOptions }
  | { kind: 'help'; text: string }
  | { kind: 'error'; message: string };

export interface ActivationStimulus {
  type: string;
  payload: unknown;
}

export interface MakaActivationRequest {
  schemaVersion: 1;
  activationId: string;
  cloudSessionId: string;
  makaSessionId?: string;
  stimulus: ActivationStimulus;
}

export interface MakaActivationContext {
  runtime: MakaActivationRuntime;
  target: {
    connection: {
      slug: string;
      name?: string;
      providerType?: string;
      enabled?: boolean;
      defaultModel?: string;
    };
    apiKey?: string;
    model: string;
  };
  cwd?: string;
  close(): Promise<void>;
}

export interface MakaActivationRuntime {
  createSession(input: CreateSessionInput): Promise<SessionSummary>;
  listSessions?(): Promise<SessionSummary[]>;
  resumeLatest?(sessionId: string): Promise<AsyncIterable<SessionEvent> | null>;
  sendMessage(sessionId: string, input: UserMessageInput): AsyncIterable<SessionEvent>;
  respondToSandboxBoundary(
    sessionId: string,
    response: { requestId: string; decision: 'deny' },
  ): Promise<void>;
  stopSession(sessionId: string, input?: { source?: 'stop_button' }): Promise<void>;
}

export interface MakaActivationDeps {
  createContext(input: MakaActivationContextInput): Promise<MakaActivationContext>;
  listSessions(stateRoot: string): Promise<SessionSummary[]>;
  workspaceRoot(): string;
  processCwd(): string;
  stdinIsTTY(): boolean;
  readStdin(): Promise<string>;
  readFile(path: string): Promise<string>;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
  onSigint(handler: () => void): () => void;
  setTimer(handler: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  newId(): string;
  canonicalDirectory?(path: string): Promise<string>;
}

export interface MakaActivationContextInput {
  readonly workspaceRoot: string;
  readonly stateRoot: string;
  readonly configRoot: string;
  readonly cwd: string;
  readonly requestedConnectionSlug?: string;
  readonly requestedModel?: string;
  readonly sessionCwdOverride?: { readonly sessionId: string; readonly cwd: string };
  readonly maxSteps?: number;
  readonly runOutcomeObserver?: (outcome: MakaRunOutcome) => void | Promise<void>;
}

interface ActivationStartLine {
  protocol: typeof PROTOCOL;
  schemaVersion: typeof SCHEMA_VERSION;
  type: 'start';
  activationId: string;
  cloudSessionId: string;
  makaSessionId?: string;
  workspaceRoot: string;
}

interface ActivationRuntimeEventLine {
  protocol: typeof PROTOCOL;
  schemaVersion: typeof SCHEMA_VERSION;
  type: 'runtime_event';
  activationId: string;
  cloudSessionId: string;
  makaSessionId?: string;
  event: RuntimeEvent;
  truncated?: boolean;
}

interface ActivationOutcomeLine {
  protocol: typeof PROTOCOL;
  schemaVersion: typeof SCHEMA_VERSION;
  type: 'outcome';
  activationId: string;
  cloudSessionId: string;
  makaSessionId?: string;
  status: MakaActivationStatus;
  reason?: string;
  requiredAction?: MakaActivationRequiredAction;
  response?: unknown;
}

export function parseMakaActivateArgs(argv: readonly string[]): ParseMakaActivateArgsResult {
  const values = new Map<string, string>();
  const valueFlags = new Set([
    'state-root',
    'workspace-root',
    'config-root',
    'input',
    'timeout',
    'max-steps',
    'permission-mode',
    'connection',
    'model',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--help' || arg === '-h') return { kind: 'help', text: makaActivateHelpText() };
    if (!arg.startsWith('--') || !valueFlags.has(arg.slice(2))) {
      return { kind: 'error', message: `unexpected argument: ${arg}` };
    }
    const name = arg.slice(2);
    if (values.has(name)) return { kind: 'error', message: `option repeated: ${arg}` };
    const value = argv[index + 1];
    if (value === undefined || (value.startsWith('--') && value !== '-')) {
      return { kind: 'error', message: `option ${arg} needs a value` };
    }
    values.set(name, value);
    index += 1;
  }

  const stateRoot = values.get('state-root');
  const workspaceRoot = values.get('workspace-root');
  const configRoot = values.get('config-root');
  if (!stateRoot || !workspaceRoot || !configRoot) {
    return {
      kind: 'error',
      message: 'activate requires --state-root, --workspace-root, and --config-root',
    };
  }
  for (const [name, value] of [
    ['state-root', stateRoot],
    ['workspace-root', workspaceRoot],
    ['config-root', configRoot],
  ] as const) {
    if (!isAbsolute(value)) return { kind: 'error', message: `--${name} must be an absolute path` };
  }

  const timeout = values.get('timeout');
  const timeoutSeconds = timeout === undefined ? undefined : Number(timeout);
  if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
    return { kind: 'error', message: '--timeout must be a positive number of seconds' };
  }
  const maxSteps = values.get('max-steps');
  const parsedMaxSteps = maxSteps === undefined ? undefined : Number(maxSteps);
  if (parsedMaxSteps !== undefined && (!Number.isInteger(parsedMaxSteps) || parsedMaxSteps < 1)) {
    return { kind: 'error', message: '--max-steps must be a positive integer' };
  }
  const permissionMode = values.get('permission-mode');
  if (
    permissionMode !== undefined &&
    permissionMode !== 'explore' &&
    permissionMode !== 'execute' &&
    permissionMode !== 'bypass'
  ) {
    return { kind: 'error', message: '--permission-mode must be explore, execute, or bypass' };
  }
  return {
    kind: 'activate',
    options: {
      stateRoot,
      workspaceRoot,
      configRoot,
      input: values.get('input') ?? '-',
      ...(timeoutSeconds === undefined ? {} : { timeoutMs: Math.ceil(timeoutSeconds * 1000) }),
      ...(parsedMaxSteps === undefined ? {} : { maxSteps: parsedMaxSteps }),
      ...(permissionMode === undefined ? {} : { permissionMode }),
      ...(values.get('connection') === undefined ? {} : { connection: values.get('connection') }),
      ...(values.get('model') === undefined ? {} : { model: values.get('model') }),
    },
  };
}

export function decodeActivationRequest(value: unknown): MakaActivationRequest {
  if (!isRecord(value)) throw new Error('activation request must be a JSON object');
  const allowed = new Set([
    'schemaVersion',
    'activationId',
    'cloudSessionId',
    'makaSessionId',
    'stimulus',
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`unsupported activation field: ${key}`);
  }
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error('unsupported activation schema');
  for (const key of ['activationId', 'cloudSessionId'] as const) {
    if (typeof value[key] !== 'string' || value[key].trim() === '') {
      throw new Error(`activation ${key} must be a non-empty string`);
    }
  }
  if (
    value.makaSessionId !== undefined &&
    (typeof value.makaSessionId !== 'string' || value.makaSessionId.trim() === '')
  ) {
    throw new Error('activation makaSessionId must be a non-empty string');
  }
  if (
    !isRecord(value.stimulus) ||
    typeof value.stimulus.type !== 'string' ||
    value.stimulus.type.trim() === '' ||
    !ACTIVATION_STIMULUS_TYPES.has(value.stimulus.type)
  ) {
    throw new Error('activation stimulus must include a type');
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    activationId: value.activationId,
    cloudSessionId: value.cloudSessionId,
    ...(value.makaSessionId === undefined ? {} : { makaSessionId: value.makaSessionId }),
    stimulus: { type: value.stimulus.type, payload: value.stimulus.payload },
  };
}

export async function runMakaActivationCli(
  argv: readonly string[],
  overrides: Partial<MakaActivationDeps> = {},
): Promise<number> {
  const deps = { ...defaultMakaActivationDeps(), ...overrides };
  const parsed = parseMakaActivateArgs(argv);
  if (parsed.kind === 'help') {
    deps.writeStdout(`${parsed.text}\n`);
    return 0;
  }
  if (parsed.kind === 'error') {
    deps.writeStderr(`maka activate: ${parsed.message}\n`);
    return 2;
  }

  const options = parsed.options;
  let request: MakaActivationRequest;
  try {
    const raw = options.input === '-' ? await deps.readStdin() : await deps.readFile(options.input);
    request = decodeActivationRequest(JSON.parse(raw));
  } catch (error) {
    const malformedRequest: MakaActivationRequest = {
      schemaVersion: SCHEMA_VERSION,
      activationId: deps.newId(),
      cloudSessionId: 'unknown',
      stimulus: { type: 'system', payload: {} },
    };
    const write = lineWriter(deps.writeStdout);
    write({
      protocol: PROTOCOL,
      schemaVersion: SCHEMA_VERSION,
      type: 'start',
      activationId: malformedRequest.activationId,
      cloudSessionId: malformedRequest.cloudSessionId,
      workspaceRoot: resolve(options.workspaceRoot),
    } satisfies ActivationStartLine);
    deps.writeStderr(`maka activate: ${safeErrorMessage(error)}\n`);
    return emitOutcome(
      deps.writeStdout,
      malformedRequest,
      undefined,
      'fatal_failure',
      'malformed_input',
    );
  }

  const write = lineWriter(deps.writeStdout);
  write({
    protocol: PROTOCOL,
    schemaVersion: SCHEMA_VERSION,
    type: 'start',
    activationId: request.activationId,
    cloudSessionId: request.cloudSessionId,
    ...(request.makaSessionId ? { makaSessionId: request.makaSessionId } : {}),
    workspaceRoot: resolve(options.workspaceRoot),
  } satisfies ActivationStartLine);

  let roots: ValidatedRoots;
  try {
    roots = await validateRoots(options);
  } catch (error) {
    emitOutcome(deps.writeStdout, request, undefined, 'fatal_failure', 'unsafe_roots');
    deps.writeStderr(`maka activate: ${safeErrorMessage(error)}\n`);
    return 2;
  }

  let sessions: SessionSummary[] = [];
  let existing: SessionSummary | undefined;
  try {
    sessions = await deps.listSessions(roots.stateRoot);
    existing = request.makaSessionId
      ? sessions.find((session) => session.id === request.makaSessionId)
      : undefined;
    if (request.makaSessionId && !existing) {
      return await finishWithoutContext(deps, request, write, 'fatal_failure', 'session_not_found');
    }
    if (existing && (!existing.cwd || !(await sameDirectory(existing.cwd, roots.workspaceRoot)))) {
      return await finishWithoutContext(
        deps,
        request,
        write,
        'fatal_failure',
        'session_cwd_mismatch',
      );
    }
    if (existing && (existing.status === 'blocked' || existing.status === 'waiting_for_user')) {
      const blockedReason = existing.blockedReason ?? 'unknown';
      if (blockedReason !== 'permission_required') {
        return await finishWithoutContext(
          deps,
          request,
          write,
          'retryable_failure',
          blockedReason,
          existing.id,
          'retry_activation',
        );
      }
      return await finishWithoutContext(
        deps,
        request,
        write,
        'blocked',
        blockedReason,
        existing.id,
        'grant_permission',
      );
    }
  } catch (error) {
    return await finishWithoutContext(
      deps,
      request,
      write,
      'fatal_failure',
      'session_lookup_failed',
    );
  }

  let context: MakaActivationContext | undefined;
  let session: SessionSummary | undefined = existing;
  let invocation: MakaRunOutcome | undefined;
  let streamBoundaryFailure = false;
  let timedOut = false;
  let interrupted = false;
  let streamFailed = false;
  let stopPromise: Promise<void> | undefined;
  let eventCount = 0;
  let eventBytes = 0;
  let eventTruncated = false;
  let terminalWritten = false;
  const writeRuntimeEvent = (event: RuntimeEvent): void => {
    if (terminalWritten || eventTruncated || eventCount >= MAX_RUNTIME_EVENTS) {
      eventTruncated = true;
      return;
    }
    const safeEvent = redactJson(event) as RuntimeEvent;
    const eventLine = {
      protocol: PROTOCOL,
      schemaVersion: SCHEMA_VERSION,
      type: 'runtime_event',
      activationId: request.activationId,
      cloudSessionId: request.cloudSessionId,
      ...(session?.id ? { makaSessionId: session.id } : {}),
      event: safeEvent,
    } satisfies ActivationRuntimeEventLine;
    const bytes = Buffer.byteLength(JSON.stringify(eventLine), 'utf8');
    if (eventBytes + bytes > MAX_RUNTIME_EVENT_BYTES) {
      eventTruncated = true;
      return;
    }
    eventBytes += bytes;
    eventCount += 1;
    write(eventLine);
  };
  try {
    context = await deps.createContext({
      workspaceRoot: roots.workspaceRoot,
      stateRoot: roots.stateRoot,
      configRoot: roots.configRoot,
      cwd: roots.workspaceRoot,
      ...(existing || options.connection
        ? { requestedConnectionSlug: existing?.llmConnectionSlug ?? options.connection }
        : {}),
      ...(existing || options.model ? { requestedModel: existing?.model ?? options.model } : {}),
      ...(existing
        ? { sessionCwdOverride: { sessionId: existing.id, cwd: roots.workspaceRoot } }
        : {}),
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
      runOutcomeObserver: (result) => {
        invocation = result;
      },
    });
    if (!session) {
      session = await context.runtime.createSession({
        cwd: roots.workspaceRoot,
        name: `Cloud activation ${request.activationId}`.slice(0, 80),
        llmConnectionSlug: context.target.connection.slug,
        model: context.target.model,
        permissionMode: options.permissionMode ?? 'explore',
      });
    }
    const stop = (): void => {
      if (stopPromise || !session) return;
      stopPromise = context!.runtime.stopSession(session.id, { source: 'stop_button' });
      void stopPromise.catch(() => {});
    };
    const removeSigint = deps.onSigint(() => {
      interrupted = true;
      stop();
    });
    let resolveTimeout: (() => void) | undefined;
    const timeoutSignal =
      options.timeoutMs === undefined
        ? undefined
        : new Promise<void>((resolve) => {
            resolveTimeout = resolve;
          });
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : deps.setTimer(() => {
            timedOut = true;
            stop();
            resolveTimeout?.();
          }, options.timeoutMs);
    try {
      const text = activationStimulusText(request.stimulus);
      const stream = await activationStream(
        context.runtime,
        session.id,
        { turnId: deps.newId(), text },
        existing !== undefined,
      );
      const drain = (async () => {
        for await (const event of stream) {
          if (sessionEventSandboxBoundaryFailureReason(event)) streamBoundaryFailure = true;
          writeRuntimeEvent(sessionEventToRuntimeEvent(event, session!.id));
          if (event.type === 'sandbox_boundary_request') {
            await context!.runtime.respondToSandboxBoundary(session!.id, {
              requestId: event.requestId,
              decision: 'deny',
            });
          }
        }
      })();
      if (timeoutSignal) await Promise.race([drain, timeoutSignal]);
      else await drain;
      await stopPromise;
    } catch (error) {
      streamFailed = true;
      await stopPromise?.catch(() => undefined);
      if (!timedOut && !interrupted)
        deps.writeStderr(`maka activate: ${safeErrorMessage(error)}\n`);
    } finally {
      removeSigint();
      if (timer !== undefined) deps.clearTimer(timer);
      await context.close();
    }
  } catch (error) {
    if (context) await context.close().catch(() => undefined);
    deps.writeStderr(`maka activate: ${safeErrorMessage(error)}\n`);
    return emitOutcome(deps.writeStdout, request, session?.id, 'fatal_failure', 'bootstrap_failed');
  }

  if (eventTruncated && !terminalWritten) {
    write({
      protocol: PROTOCOL,
      schemaVersion: SCHEMA_VERSION,
      type: 'runtime_event',
      activationId: request.activationId,
      cloudSessionId: request.cloudSessionId,
      ...(session?.id ? { makaSessionId: session.id } : {}),
      event: { truncated: true } as unknown as RuntimeEvent,
      truncated: true,
    });
  }
  const finish = (
    status: MakaActivationStatus,
    reason?: string,
    response?: unknown,
    requiredAction?: MakaActivationRequiredAction,
  ): number => {
    if (terminalWritten)
      return status === 'completed'
        ? 0
        : status === 'blocked'
          ? 3
          : status === 'retryable_failure'
            ? 4
            : 2;
    terminalWritten = true;
    return emitOutcome(
      deps.writeStdout,
      request,
      session?.id,
      status,
      reason,
      response,
      requiredAction,
    );
  };
  if (interrupted) return finish('retryable_failure', 'interrupted');
  if (timedOut) return finish('retryable_failure', 'timeout');
  if (streamFailed) return finish('retryable_failure', 'runtime_error');
  if (invocation?.failure?.class === 'permission_denied') {
    return finish('blocked', 'permission_denied', undefined, 'grant_permission');
  }
  if (
    (streamBoundaryFailure && invocation?.sandboxBoundary !== 'recovered') ||
    invocation?.sandboxBoundary === 'unresolved'
  ) {
    return finish('blocked', 'permission_required', undefined, 'grant_permission');
  }
  if (!invocation) return finish('fatal_failure', 'missing_invocation');
  if (invocation.status === 'completed' && invocation.finalOutput !== undefined) {
    return finish('completed', undefined, invocation.finalOutput);
  }
  if (invocation.status === 'completed') return finish('fatal_failure', 'missing_response');
  const failureClass = invocation.failure?.class ?? 'runtime_failure';
  const blocked = failureClass === 'permission_denied' || failureClass === 'permission_required';
  return finish(
    blocked ? 'blocked' : 'retryable_failure',
    blocked ? failureClass : 'runtime_failure',
    undefined,
    blocked ? 'grant_permission' : undefined,
  );
}

async function finishWithoutContext(
  deps: MakaActivationDeps,
  request: MakaActivationRequest,
  write: (line: object) => void,
  status: MakaActivationStatus,
  reason: string,
  sessionId?: string,
  requiredAction?: MakaActivationRequiredAction,
): Promise<number> {
  return emitOutcome(
    deps.writeStdout,
    request,
    sessionId,
    status,
    reason,
    undefined,
    requiredAction,
  );
}

function emitOutcome(
  output: (text: string) => void,
  request: MakaActivationRequest,
  sessionId: string | undefined,
  status: MakaActivationStatus,
  reason?: string,
  response?: unknown,
  requiredAction?: MakaActivationRequiredAction,
): number {
  const outcome: ActivationOutcomeLine = {
    protocol: PROTOCOL,
    schemaVersion: SCHEMA_VERSION,
    type: 'outcome',
    activationId: request.activationId,
    cloudSessionId: request.cloudSessionId,
    ...(sessionId ? { makaSessionId: sessionId } : {}),
    status,
    ...(reason ? { reason } : {}),
    ...(requiredAction ? { requiredAction } : {}),
    ...(response === undefined ? {} : { response: boundedRedactedJson(response) }),
  };
  output(`${JSON.stringify(redactJson(outcome))}\n`);
  return status === 'completed'
    ? 0
    : status === 'blocked'
      ? 3
      : status === 'retryable_failure'
        ? 4
        : 2;
}

function boundedRedactedJson(value: unknown): unknown {
  const redacted = redactJson(value);
  const serialized = JSON.stringify(redacted);
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') <= MAX_OUTPUT_BYTES) {
    return redacted;
  }
  return redactSecrets(serialized).slice(0, MAX_OUTPUT_BYTES);
}

function lineWriter(output: (text: string) => void): (line: object) => void {
  let emittedOutcome = false;
  return (line) => {
    if ((line as { type?: string }).type === 'outcome') {
      if (emittedOutcome) return;
      emittedOutcome = true;
    }
    output(`${JSON.stringify(redactJson(line))}\n`);
  };
}

interface ValidatedRoots {
  stateRoot: string;
  workspaceRoot: string;
  configRoot: string;
}

async function validateRoots(options: MakaActivationOptions): Promise<ValidatedRoots> {
  await assertActivationRootLayout(options);
  const workspaceRoot = await canonicalExistingDirectory(options.workspaceRoot);
  const stateRoot = await canonicalCreateDirectory(options.stateRoot);
  const configRoot = await canonicalCreateDirectory(options.configRoot);
  await assertActivationRootLayout({ stateRoot, workspaceRoot, configRoot });
  return { stateRoot, workspaceRoot, configRoot };
}

async function assertActivationRootLayout(
  roots: Pick<MakaActivationOptions, 'stateRoot' | 'workspaceRoot' | 'configRoot'>,
): Promise<void> {
  await Promise.all([
    assertSessionBundleRootLayout({
      stateRoot: roots.stateRoot,
      configRoot: roots.workspaceRoot,
    }),
    assertSessionBundleRootLayout({
      stateRoot: roots.stateRoot,
      configRoot: roots.configRoot,
    }),
    assertSessionBundleRootLayout({
      stateRoot: roots.workspaceRoot,
      configRoot: roots.configRoot,
    }),
  ]);
}

async function canonicalExistingDirectory(path: string): Promise<string> {
  const canonical = await realpath(resolve(path));
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new Error(`root is not a directory: ${path}`);
  return canonical;
}

async function canonicalCreateDirectory(path: string): Promise<string> {
  await mkdir(resolve(path), { recursive: true });
  return canonicalExistingDirectory(path);
}

async function sameDirectory(left: string, right: string): Promise<boolean> {
  try {
    return (await canonicalExistingDirectory(left)) === right;
  } catch {
    return resolve(left) === resolve(right);
  }
}

function activationStimulusText(stimulus: ActivationStimulus): string {
  const payload = stimulus.payload;
  if (!isRecord(payload)) return JSON.stringify({ type: stimulus.type, payload });
  for (const key of ['text', 'prompt', 'message'] as const) {
    if (typeof payload[key] === 'string' && payload[key].trim()) return payload[key];
  }
  return JSON.stringify({ type: stimulus.type, payload });
}

async function activationStream(
  runtime: MakaActivationRuntime,
  sessionId: string,
  input: UserMessageInput,
  allowSafeBoundaryResume: boolean,
): Promise<AsyncIterable<SessionEvent>> {
  if (allowSafeBoundaryResume && runtime.resumeLatest) {
    const resumed = await runtime.resumeLatest(sessionId);
    if (resumed) return resumed;
  }
  return runtime.sendMessage(sessionId, input);
}

function sessionEventToRuntimeEvent(event: SessionEvent, sessionId: string): RuntimeEvent {
  return {
    id: event.id,
    invocationId: `activation-${sessionId}`,
    runId: event.turnId,
    sessionId,
    turnId: event.turnId,
    ts: event.ts,
    partial: false,
    role: 'tool',
    author: 'system',
    content: { kind: 'text', text: event.type },
  } as RuntimeEvent;
}

function redactJson(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? value : JSON.parse(redactSecrets(serialized));
  } catch {
    return '[redacted]';
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message).slice(0, 500);
}

function makaActivateHelpText(): string {
  return [
    'Usage: maka activate --state-root <path> --workspace-root <path> --config-root <path>',
    '',
    'Read a versioned activation request from stdin or --input <file> and emit JSONL.',
    '',
    'Options:',
    '  --state-root <path>       Session-owned state directory (required)',
    '  --workspace-root <path>   Activation workspace directory (required)',
    '  --config-root <path>      Configuration directory (required)',
    '  --input <path>            JSON request file, or - for stdin (default: -)',
    '  --timeout <seconds>       Invocation timeout',
    '  --max-steps <count>       Tool-step cap',
    '  --permission-mode <mode>  explore|execute|bypass',
    '  --connection <slug>       Model connection override',
    '  --model <id>              Model override',
  ].join('\n');
}

function defaultMakaActivationDeps(): MakaActivationDeps {
  return {
    createContext: createRuntimeHostActivationContext,
    listSessions: listRuntimeHostActivationSessions,
    workspaceRoot: () => resolve(process.cwd()),
    processCwd: () => process.cwd(),
    stdinIsTTY: () => process.stdin.isTTY === true,
    readStdin: readProcessStdin,
    readFile: async (path) => readFile(path, 'utf8'),
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
    onSigint: (handler) => {
      process.on('SIGINT', handler);
      return () => process.off('SIGINT', handler);
    },
    setTimer: (handler, ms) => {
      const timer = setTimeout(handler, ms);
      timer.unref();
      return timer;
    },
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    newId: randomUUID,
  };
}

async function createRuntimeHostActivationContext(
  input: MakaActivationContextInput,
): Promise<MakaActivationContext> {
  const connected = await connectRuntimeHostCli({
    rootPath: input.stateRoot,
  });
  try {
    const target = resolveRuntimeHostCliTarget(connected.catalog, {
      ...(input.requestedConnectionSlug ? { connectionSlug: input.requestedConnectionSlug } : {}),
      ...(input.requestedModel ? { model: input.requestedModel } : {}),
    });
    const runContext = createRuntimeHostRunContext(connected.connection, connected.catalog, {
      workspaceRoot: input.stateRoot,
      cwd: input.cwd,
      requestedConnectionSlug: target.connection.slug,
      requestedModel: target.model,
      ...(input.sessionCwdOverride ? { sessionCwdOverride: { ...input.sessionCwdOverride } } : {}),
      ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
      ...(input.runOutcomeObserver ? { runOutcomeObserver: input.runOutcomeObserver } : {}),
    });
    return {
      runtime: runContext.runtime,
      target: {
        connection: {
          slug: target.connection.slug,
          name: target.connection.name,
          providerType: target.connection.providerType,
          enabled: target.connection.enabled,
          defaultModel: target.model,
        },
        model: target.model,
      },
      cwd: input.cwd,
      close: async () => {
        await runContext.close();
        await connected.close();
      },
    };
  } catch (error) {
    await connected.close().catch(() => undefined);
    throw error;
  }
}

async function listRuntimeHostActivationSessions(stateRoot: string): Promise<SessionSummary[]> {
  const connected = await connectRuntimeHostCli({
    rootPath: stateRoot,
  });
  try {
    return (await readRuntimeHostSessions(connected.connection)).flatMap((session) =>
      'kind' in session ? [] : [runtimeHostSessionSummary(session)],
    );
  } finally {
    await connected.close();
  }
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
