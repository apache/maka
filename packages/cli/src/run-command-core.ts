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

import {
  RunQuestionAvailable,
  RunSessionInterrupted,
  type MakaRunSessionResult,
} from './run-session-result.js';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { SessionEvent } from '@maka/core/events';
import { isThinkingLevel, type ThinkingLevel } from '@maka/core/model-thinking';
import type { UserMessageInput } from '@maka/core/runtime-inputs';
import type { ExecutionBoundaryReadModel } from '@maka/core/sandbox-boundary';
import type { SessionSummary } from '@maka/core/session';
import { normalizeUserSessionName } from '@maka/core/session-name';
import type { CreateSessionRequest } from './session-driver.js';
import { selectMakaRunSession } from './run-session-selection.js';
import { sessionEventSandboxBoundaryFailureReason } from './sandbox-boundary-failure.js';
import { resolveMakaWorkspaceRoot } from './workspace-root.js';

export interface MakaRunOptions {
  sessionId?: string;
  wait?: true;
  noWait?: true;
  json?: true;
  status?: true;
  result?: true;
  resumeExecution?: true;
  stop?: true;
  sandboxDecision?: 'allow' | 'deny';
  placement?: 'current_turn' | 'next_turn';
  answers?: readonly (string | null)[];
  prompt?: string;
  stdinPrompt: boolean;
  cwd?: string;
  connection?: string;
  model?: string;
  thinking?: ThinkingLevel | null;
  timeoutMs?: number;
  maxSteps?: number;
  yolo?: boolean;
  resumeId?: string;
  continueLatest?: boolean;
  graph?: true;
  hostProfileId?: string;
  projectId?: string;
}

export type ParseMakaRunArgsResult =
  | { kind: 'run'; options: MakaRunOptions }
  | { kind: 'help' }
  | { kind: 'error'; message: string };

export interface MakaRunRuntime {
  createSession(input: CreateSessionRequest): Promise<SessionSummary>;
  readExecutionBoundary(sessionId: string): Promise<ExecutionBoundaryReadModel>;
  sendMessage(sessionId: string, input: UserMessageInput): AsyncIterable<SessionEvent>;
  respondToSandboxBoundary(
    sessionId: string,
    response: { requestId: string; decision: 'deny' },
  ): Promise<void>;
  stopSession(sessionId: string, input?: { source?: 'stop_button' }): Promise<void>;
  setExecutionBoundaryKind(sessionId: string, kind: 'managed' | 'bypass'): Promise<unknown>;
  resumeLatest?(sessionId: string): Promise<AsyncIterable<SessionEvent> | null>;
}

export interface MakaRunContext {
  runtime: MakaRunRuntime;
  target: { connection: { slug: string }; model: string };
  agentGraph?: {
    reserveActivity(sessionId: string): { release(): void };
    waitForCompletion(sessionId: string): Promise<void>;
  };
  close(): Promise<void>;
}

export interface MakaRunOutcome {
  outcomeId: string;
  status: 'completed' | 'failed' | 'running';
  finalOutput?: string;
  failure?: { class: string; message?: string };
  sandboxBoundary: 'none' | 'unresolved';
}

export interface MakaRunContextInput {
  noWait?: boolean;
  allowDetach?: boolean;
  workspaceRoot: string;
  cwd: string;
  requestedConnectionSlug?: string;
  requestedModel?: string;
  maxSteps?: number;
  enableAgentGraph?: boolean;
  resumeSessionId?: string;
  sessionCwdOverride?: { sessionId: string; cwd: string };
  runOutcomeObserver?: (outcome: MakaRunOutcome) => void | Promise<void>;
  hostProfileId?: string;
  projectId?: string;
}

export interface MakaRunDeps {
  runSession?(options: MakaRunOptions, env: MakaRunEnvironmentDeps): Promise<MakaRunSessionResult>;
  createContext(input: MakaRunContextInput): Promise<MakaRunContext>;
  listSessions(workspaceRoot: string, hostProfileId?: string): Promise<SessionSummary[]>;
  workspaceRoot(): string;
  cliCommand(): string;
  processCwd(): string;
  stdinIsTTY(): boolean;
  readStdin(): Promise<string>;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
  onSigint(handler: () => void): () => void;
  setTimer(handler: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  newId(): string;
}

export type MakaRunAdapter = Pick<MakaRunDeps, 'createContext' | 'listSessions' | 'runSession'>;
export type MakaRunEnvironmentDeps = Omit<MakaRunDeps, keyof MakaRunAdapter>;

const VALUE_FLAGS = new Set([
  'session',
  'answer',
  'cwd',
  'connection',
  'model',
  'thinking',
  'timeout',
  'max-steps',
  'resume',
  'host',
  'project',
]);

const REPEATABLE_VALUE_FLAGS = new Set<string>();
const BOOLEAN_FLAGS = new Set([
  'continue',
  'yolo',
  'graph',
  'wait',
  'no-wait',
  'json',
  'status',
  'result',
  'queue',
  'steer',
  'stop',
  'approve',
  'deny',
]);

export function parseMakaRunArgs(argv: readonly string[]): ParseMakaRunArgsResult {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  const booleanFlags = new Set<string>();
  let literal = false;
  const optionArgs = argv.includes('--') ? argv.slice(0, argv.indexOf('--')) : argv;
  const selectsSession = optionArgs.includes('--session');
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!literal && (arg === '--help' || arg === '-h')) return { kind: 'help' };
    if (!literal && arg === '--') {
      literal = true;
      continue;
    }
    if (!literal && arg.startsWith('--')) {
      const name = arg.slice(2);
      if (BOOLEAN_FLAGS.has(name) || (name === 'resume' && selectsSession)) {
        if (booleanFlags.has(name)) return { kind: 'error', message: `option repeated: ${arg}` };
        booleanFlags.add(name);
        continue;
      }
      if (!VALUE_FLAGS.has(name)) return { kind: 'error', message: `unknown option: ${arg}` };
      if (!REPEATABLE_VALUE_FLAGS.has(name) && flags.has(name)) {
        return { kind: 'error', message: `option repeated: ${arg}` };
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return { kind: 'error', message: `option ${arg} needs a value` };
      }
      flags.set(name, value);
      index += 1;
      continue;
    }
    if (!literal && arg.startsWith('-') && arg !== '-') {
      return { kind: 'error', message: `unknown option: ${arg}` };
    }
    positional.push(arg);
  }

  if (positional.length > 1) {
    return { kind: 'error', message: 'maka run accepts at most one positional prompt' };
  }
  const sessionId = flags.get('session');
  const resumeExecution = booleanFlags.has('resume');
  if (sessionId !== undefined && !sessionId.trim())
    return { kind: 'error', message: '--session requires a non-empty Session ID' };
  if (booleanFlags.has('wait') && booleanFlags.has('no-wait')) {
    return { kind: 'error', message: '--wait and --no-wait cannot be used together' };
  }
  if (booleanFlags.has('queue') && booleanFlags.has('steer')) {
    return { kind: 'error', message: '--queue and --steer cannot be used together' };
  }
  const actions =
    Number(booleanFlags.has('status')) +
    Number(booleanFlags.has('result')) +
    Number(flags.has('answer')) +
    Number(resumeExecution) +
    Number(booleanFlags.has('stop')) +
    Number(booleanFlags.has('approve')) +
    Number(booleanFlags.has('deny'));
  if (actions > 1)
    return {
      kind: 'error',
      message: 'choose one of --status, --result, --answer, --approve, --deny, --resume or --stop',
    };
  if ((booleanFlags.has('approve') || booleanFlags.has('deny')) && booleanFlags.has('yolo'))
    return {
      kind: 'error',
      message:
        '--approve/--deny answer only the current sandbox request; do not combine with --yolo',
    };
  if (!sessionId && (actions || booleanFlags.has('queue') || booleanFlags.has('steer'))) {
    return { kind: 'error', message: 'session operations require --session <session-id>' };
  }
  if (sessionId && (booleanFlags.has('continue') || flags.has('project'))) {
    return {
      kind: 'error',
      message: '--session cannot be combined with --continue or --project',
    };
  }
  if (actions && positional.length)
    return { kind: 'error', message: 'session actions do not accept a prompt' };
  if ((booleanFlags.has('queue') || booleanFlags.has('steer')) && (!positional.length || actions)) {
    return { kind: 'error', message: '--queue and --steer require a prompt' };
  }
  if (
    (booleanFlags.has('status') || booleanFlags.has('result') || booleanFlags.has('stop')) &&
    (booleanFlags.has('wait') || booleanFlags.has('no-wait'))
  ) {
    return { kind: 'error', message: '--status, --result and --stop do not accept wait options' };
  }
  if (booleanFlags.has('graph') && booleanFlags.has('no-wait')) {
    return { kind: 'error', message: '--graph must wait for its final result' };
  }
  let answers: (string | null)[] | undefined;
  if (flags.has('answer')) {
    try {
      const value: unknown = JSON.parse(flags.get('answer')!);
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.some((v) => v !== null && typeof v !== 'string')
      )
        throw new Error();
      answers = value;
    } catch {
      return {
        kind: 'error',
        message: '--answer expects a JSON array of strings or null, e.g. ["Yes"]',
      };
    }
  }
  const prompt = positional[0];
  const timeout = flags.get('timeout');
  const maxSteps = flags.get('max-steps');
  const thinking = flags.get('thinking');
  const resumeId = flags.get('resume');
  const continueLatest = booleanFlags.has('continue');
  const graph = booleanFlags.has('graph');
  if (resumeId !== undefined && continueLatest) {
    return { kind: 'error', message: '--resume and --continue cannot be used together' };
  }
  if (flags.has('project') && (resumeId !== undefined || continueLatest)) {
    return { kind: 'error', message: '--project cannot be used with --resume or --continue' };
  }
  if (flags.get('host') && flags.get('host') !== 'local' && continueLatest) {
    return { kind: 'error', message: '--continue is unavailable for a remote Runtime Host' };
  }
  if (flags.get('host') && flags.get('host') !== 'local' && flags.has('cwd')) {
    return { kind: 'error', message: '--cwd cannot be used with a remote Runtime Host' };
  }
  const timeoutSeconds = timeout === undefined ? undefined : Number(timeout);
  if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
    return { kind: 'error', message: '--timeout must be a positive number of seconds' };
  }
  const parsedMaxSteps = maxSteps === undefined ? undefined : Number(maxSteps);
  if (parsedMaxSteps !== undefined && (!Number.isInteger(parsedMaxSteps) || parsedMaxSteps < 1)) {
    return { kind: 'error', message: '--max-steps must be a positive integer' };
  }
  if (thinking !== undefined && thinking !== 'default' && !isThinkingLevel(thinking)) {
    return { kind: 'error', message: `unknown thinking level: ${thinking}` };
  }
  return {
    kind: 'run',
    options: {
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(booleanFlags.has('wait') ? { wait: true as const } : {}),
      ...(booleanFlags.has('no-wait') ? { noWait: true as const } : {}),
      ...(booleanFlags.has('json') ? { json: true as const } : {}),
      ...(booleanFlags.has('status') ? { status: true as const } : {}),
      ...(booleanFlags.has('result') ? { result: true as const } : {}),
      ...(resumeExecution ? { resumeExecution: true as const } : {}),
      ...(booleanFlags.has('stop') ? { stop: true as const } : {}),
      ...(booleanFlags.has('approve')
        ? { sandboxDecision: 'allow' as const }
        : booleanFlags.has('deny')
          ? { sandboxDecision: 'deny' as const }
          : {}),
      ...(answers ? { answers } : {}),
      ...(booleanFlags.has('steer')
        ? { placement: 'current_turn' as const }
        : booleanFlags.has('queue')
          ? { placement: 'next_turn' as const }
          : {}),
      ...(prompt !== undefined && prompt !== '-' ? { prompt } : {}),
      stdinPrompt: prompt === '-',
      ...(flags.get('cwd') !== undefined ? { cwd: flags.get('cwd') } : {}),
      ...(flags.get('connection') !== undefined ? { connection: flags.get('connection') } : {}),
      ...(flags.get('model') !== undefined ? { model: flags.get('model') } : {}),
      ...(thinking !== undefined ? { thinking: thinking === 'default' ? null : thinking } : {}),
      ...(timeoutSeconds !== undefined ? { timeoutMs: Math.ceil(timeoutSeconds * 1_000) } : {}),
      ...(parsedMaxSteps !== undefined ? { maxSteps: parsedMaxSteps } : {}),
      ...(booleanFlags.has('yolo') ? { yolo: true } : {}),
      ...(resumeId !== undefined ? { resumeId } : {}),
      ...(continueLatest ? { continueLatest: true } : {}),
      ...(graph ? { graph: true as const } : {}),
      ...(flags.get('host') !== undefined ? { hostProfileId: flags.get('host') } : {}),
      ...(flags.get('project') !== undefined ? { projectId: flags.get('project') } : {}),
    },
  };
}

export async function runMakaTextCliCore(
  argv: readonly string[],
  adapter: MakaRunAdapter,
  overrides: Partial<MakaRunEnvironmentDeps> = {},
): Promise<number> {
  const deps: MakaRunDeps = { ...defaultMakaRunEnvironmentDeps(), ...adapter, ...overrides };
  const parsed = parseMakaRunArgs(argv);
  if (parsed.kind === 'help') {
    deps.writeStdout(`${makaRunHelpText(deps.cliCommand())}\n`);
    return 0;
  }
  if (parsed.kind === 'error') {
    deps.writeStderr(`maka run: ${parsed.message}\n\n${makaRunHelpText(deps.cliCommand())}\n`);
    return 2;
  }

  if (parsed.options.sessionId) {
    try {
      if (!deps.runSession)
        throw new Error('Session operations are unavailable in this CLI runtime');
      const options = { ...parsed.options };
      // Queries and answers must not block reading an unrelated stdin stream.
      if (options.prompt !== undefined || options.stdinPrompt)
        options.prompt = await resolveRunPrompt(options, deps);
      const result = await deps.runSession(options, deps);
      writeSessionResult(result, deps, options.json === true);
      const returnsTaskOutcome =
        options.prompt !== undefined ||
        options.answers !== undefined ||
        options.resumeExecution ||
        options.sandboxDecision !== undefined ||
        options.wait ||
        options.result;
      return result.status === 'failed' && returnsTaskOutcome ? 1 : 0;
    } catch (error) {
      deps.writeStderr(`maka run: ${errorMessage(error)}\n`);
      return error instanceof RunSessionInterrupted ? 130 : 1;
    }
  }

  let prompt: string;
  let selection: Awaited<ReturnType<typeof selectMakaRunSession>>;
  const workspaceRoot = deps.workspaceRoot();
  try {
    prompt = await resolveRunPrompt(parsed.options, deps);
    const sessions =
      parsed.options.resumeId !== undefined || parsed.options.continueLatest === true
        ? await deps.listSessions(workspaceRoot, parsed.options.hostProfileId)
        : [];
    selection = await selectMakaRunSession(
      {
        sessions,
        ...(parsed.options.resumeId !== undefined ? { resumeId: parsed.options.resumeId } : {}),
        continueLatest: parsed.options.continueLatest === true,
        ...(parsed.options.cwd !== undefined ? { explicitCwd: parsed.options.cwd } : {}),
        processCwd: deps.processCwd(),
        ...(parsed.options.connection !== undefined
          ? { explicitConnection: parsed.options.connection }
          : {}),
        ...(parsed.options.model !== undefined ? { explicitModel: parsed.options.model } : {}),
        thinkingSpecified: parsed.options.thinking !== undefined,
        ...(parsed.options.thinking != null ? { explicitThinking: parsed.options.thinking } : {}),
      },
      {
        canonicalizeDirectory: canonicalDirectory,
        ...(parsed.options.hostProfileId && parsed.options.hostProfileId !== 'local'
          ? { canonicalizeStoredDirectory: async (path: string) => path }
          : {}),
      },
    );
  } catch (error) {
    deps.writeStderr(`maka run: ${errorMessage(error)}\n`);
    return 2;
  }

  let outcome: MakaRunOutcome | undefined;
  let boundaryFailure = false;
  let context: MakaRunContext;
  try {
    context = await deps.createContext({
      ...(parsed.options.noWait ? { noWait: true } : {}),
      workspaceRoot,
      cwd: selection.cwd,
      ...(selection.kind === 'existing' || parsed.options.connection
        ? {
            requestedConnectionSlug:
              selection.kind === 'existing'
                ? selection.session.llmConnectionSlug
                : parsed.options.connection,
          }
        : {}),
      ...(selection.kind === 'existing' || parsed.options.model
        ? {
            requestedModel:
              selection.kind === 'existing' ? selection.session.model : parsed.options.model,
          }
        : {}),
      ...(selection.kind === 'existing' &&
      (!parsed.options.hostProfileId || parsed.options.hostProfileId === 'local')
        ? { sessionCwdOverride: { sessionId: selection.session.id, cwd: selection.cwd } }
        : {}),
      ...(selection.kind === 'existing' ? { resumeSessionId: selection.session.id } : {}),
      ...(parsed.options.maxSteps !== undefined ? { maxSteps: parsed.options.maxSteps } : {}),
      ...(parsed.options.graph ? { enableAgentGraph: true } : {}),
      ...(parsed.options.hostProfileId ? { hostProfileId: parsed.options.hostProfileId } : {}),
      ...(parsed.options.projectId ? { projectId: parsed.options.projectId } : {}),
      runOutcomeObserver: (result) => {
        if (result.sandboxBoundary === 'unresolved') boundaryFailure = true;
        outcome = result;
      },
    });
  } catch (error) {
    deps.writeStderr(`maka run: ${errorMessage(error)}\n`);
    return 2;
  }

  let session: SessionSummary;
  try {
    session =
      selection.kind === 'existing'
        ? selection.session
        : await context.runtime.createSession({
            cwd: selection.cwd,
            name: makaRunSessionName(prompt),
            llmConnectionSlug: context.target.connection.slug,
            model: context.target.model,
            // `--yolo` is a one-shot elevation, not one half of a choice.
            // Omitting the field lets the Session start in the Host's
            // configured default instead of forcing Auto onto every run.
            ...(parsed.options.yolo ? { permissionMode: 'bypass' as const } : {}),
            ...(parsed.options.thinking !== undefined
              ? { thinkingLevel: parsed.options.thinking }
              : {}),
          });
    if (selection.kind === 'existing') {
      const boundary = await context.runtime.readExecutionBoundary(session.id);
      if (parsed.options.yolo) {
        await context.runtime.setExecutionBoundaryKind(session.id, 'bypass');
      } else if (boundary.kind === 'bypass') {
        throw new Error(`resuming a full-access session ${session.id} requires --yolo`);
      } else if (boundary.kind === 'external') {
        throw new Error(`cannot resume externally isolated session ${session.id} from maka run`);
      }
    }
  } catch (error) {
    await context.close();
    deps.writeStderr(`maka run: ${errorMessage(error)}\n`);
    return 2;
  }

  let interrupted = false;
  let timedOut = false;
  let streamFailed = false;
  let question: RunQuestionAvailable | undefined;
  let stopPromise: Promise<void> | undefined;
  let resolveStopSignal: (() => void) | undefined;
  const stopSignal = new Promise<void>((resolve) => {
    resolveStopSignal = resolve;
  });
  const stop = (): void => {
    resolveStopSignal?.();
    resolveStopSignal = undefined;
    if (stopPromise) return;
    stopPromise = context.runtime.stopSession(session.id, { source: 'stop_button' });
    void stopPromise.catch(() => {});
  };
  const removeSigint = deps.onSigint(() => {
    interrupted = true;
    stop();
  });
  const timer =
    parsed.options.timeoutMs === undefined
      ? undefined
      : deps.setTimer(() => {
          timedOut = true;
          stop();
        }, parsed.options.timeoutMs);
  const graphActivity = parsed.options.graph
    ? context.agentGraph?.reserveActivity(session.id)
    : undefined;

  try {
    if (parsed.options.graph && !context.agentGraph) {
      throw new Error('Graph Mode is unavailable in this CLI runtime');
    }
    for await (const event of context.runtime.sendMessage(session.id, {
      turnId: deps.newId(),
      text: prompt,
      ...(parsed.options.maxSteps !== undefined ? { maxSteps: parsed.options.maxSteps } : {}),
      ...(parsed.options.graph
        ? { turnOrchestration: { mode: 'graph' as const, source: 'host_api' as const } }
        : {}),
    })) {
      if (event.type === 'sandbox_boundary_request') {
        boundaryFailure = true;
        deps.writeStderr(
          'maka run: sandbox boundary expansion is unavailable in non-interactive mode\n',
        );
        await context.runtime.respondToSandboxBoundary(session.id, {
          requestId: event.requestId,
          decision: 'deny',
        });
      }
      const sandboxFailureReason = sessionEventSandboxBoundaryFailureReason(event);
      if (sandboxFailureReason) {
        boundaryFailure = true;
        deps.writeStderr(
          sandboxFailureReason === 'requires_bypass'
            ? 'maka run: sandbox bypass requires an explicit --yolo\n'
            : 'maka run: sandbox boundary expansion is unavailable in non-interactive mode\n',
        );
      }
    }
    graphActivity?.release();
    if (parsed.options.graph && outcome?.status === 'completed') {
      await Promise.race([context.agentGraph!.waitForCompletion(session.id), stopSignal]);
    }
    await stopPromise;
  } catch (error) {
    question = error instanceof RunQuestionAvailable ? error : undefined;
    streamFailed = !question;
    graphActivity?.release();
    await stopPromise?.catch(() => undefined);
    if (!interrupted && !timedOut && !question) {
      deps.writeStderr(`maka run: ${errorMessage(error)}\n`);
    }
  } finally {
    removeSigint();
    if (timer !== undefined) deps.clearTimer(timer);
    await context.close();
  }

  if (interrupted) return 130;
  if (timedOut) {
    deps.writeStderr(`maka run: timed out after ${parsed.options.timeoutMs}ms\n`);
    return 1;
  }
  if (question) {
    writeSessionResult(question.result(), deps, true);
    return 0;
  }
  if (streamFailed) return 1;
  if (boundaryFailure) return 1;
  if (!outcome) {
    deps.writeStderr('maka run: runtime produced no outcome\n');
    return 1;
  }
  if (outcome.status === 'running') {
    writeSessionResult(
      { sessionId: session.id, status: 'running', submission: 'started' },
      deps,
      true,
    );
    return 0;
  }
  if (outcome.status !== 'completed' || outcome.finalOutput === undefined) {
    const detail = outcome.failure?.message ?? outcome.failure?.class ?? 'runtime failure';
    deps.writeStderr(`maka run: ${detail}\n`);
    return 1;
  }
  writeSessionResult(
    { sessionId: session.id, status: 'completed', finalOutput: outcome.finalOutput },
    deps,
    parsed.options.json === true,
  );
  return 0;
}

export function writeSessionResult(
  result: MakaRunSessionResult,
  deps: Pick<MakaRunDeps, 'writeStdout' | 'writeStderr'>,
  json: boolean,
): void {
  if (json || result.status !== 'completed') deps.writeStdout(`${JSON.stringify(result)}\n`);
  else deps.writeStdout(withTrailingNewline(result.finalOutput ?? ''));
  if (result.status === 'failed' && result.error) deps.writeStderr(`maka run: ${result.error}\n`);
}

async function resolveRunPrompt(options: MakaRunOptions, deps: MakaRunDeps): Promise<string> {
  const shouldReadStdin = options.stdinPrompt || !deps.stdinIsTTY();
  const stdin = shouldReadStdin ? await deps.readStdin() : '';
  if (options.stdinPrompt || options.prompt === undefined) {
    if (stdin.trim().length === 0) throw new Error('missing prompt input');
    return stdin;
  }
  if (options.prompt.trim().length === 0) throw new Error('missing prompt input');
  return stdin.trim().length > 0 ? `${options.prompt}\n\n${stdin}` : options.prompt;
}

async function canonicalDirectory(input: string): Promise<string> {
  const canonical = await realpath(resolve(input));
  if (!(await stat(canonical)).isDirectory()) throw new Error(`cwd is not a directory: ${input}`);
  return canonical;
}

function makaRunHelpText(cliCommand: string): string {
  return [
    `Usage: ${cliCommand} run [PROMPT] [options]`,
    `       ${cliCommand} -p [PROMPT] [options]`,
    '',
    'Input:',
    '  -                         Read the complete prompt from stdin',
    '  PROMPT with piped stdin   Use PROMPT as instruction and stdin as context',
    '',
    'Options:',
    '  --cwd <path>              Working directory (default: current directory)',
    '  --connection <slug>       Model connection to use',
    '  --host <profile-id>       Connect through a saved Runtime Host profile',
    '  --project <project-id>    Select an existing Project on a remote Host',
    '  --model <id>              Model to use',
    '  --thinking <level>        off|on|minimal|low|medium|high|xhigh|max|default',
    '  --timeout <seconds>       Invocation timeout',
    '  --max-steps <count>       Tool-step cap',
    '  --yolo                    Grant full access; Session controls otherwise inherit saved access',
    '  --session <session-id>    Select a Session (without a prompt: show its status)',
    '  --wait                    Wait for this message/current Turn; return input/approval early',
    '  --no-wait                 Submit and return (Host-owned execution only)',
    '  --status                  Read current Session status without executing',
    '  --result                  Read the latest Turn result without waiting',
    '  --stop                    Request stop for the current Turn (no --yolo needed)',
    '  --answer <json-array>     Answer the current AskUser, e.g. ["Yes",null]',
    '  --approve                 Approve the single pending sandbox expansion',
    '  --deny                    Deny the single pending sandbox expansion',
    '  --queue                   Queue this prompt as its own next Turn (default)',
    '  --steer                   Add this prompt to the current execution',
    '  --json                    Return a structured result, including the Session ID',
    '  --session <id> --resume   Safely resume stopped execution',
    '  --resume <session-id>     Legacy Session selector (prefer --session)',
    '  --continue                Continue the latest compatible task for cwd',
    '  --graph                   Run this turn in Graph Mode and wait for graph completion',
    '  -h, --help                Show help',
    '',
    'Session controls inherit saved permissions; --yolo explicitly grants full access.',
    '--status reports the execution boundary; a read-only prompt does not restrict permissions.',
    'Legacy --resume <id> still requires --yolo for a full-access Session.',
    '--approve/--deny decide a sandbox request without changing the Session to full access.',
  ].join('\n');
}

function defaultMakaRunEnvironmentDeps(): MakaRunEnvironmentDeps {
  return {
    workspaceRoot: () => resolveMakaWorkspaceRoot(),
    cliCommand: () => 'maka',
    processCwd: () => process.cwd(),
    stdinIsTTY: () => process.stdin.isTTY === true,
    readStdin: readProcessStdin,
    writeStdout: (text) => {
      process.stdout.write(text);
    },
    writeStderr: (text) => {
      process.stderr.write(text);
    },
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

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  );
}

function makaRunSessionName(prompt: string): string {
  const normalized = normalizeUserSessionName(firstLine(prompt).slice(0, 42));
  return normalized.ok ? normalized.value : 'Maka run';
}

function withTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
