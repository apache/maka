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

import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';

export type RiveCliAction =
  | 'workflow_validate'
  | 'workflow_import'
  | 'workflow_run'
  | 'workflow_status'
  | 'scheduler_status'
  | 'scheduler_resume'
  | 'work_retry'
  | 'branch_conflict_show';

export interface RiveCliToolArgs {
  action: RiveCliAction;
  path?: string;
  templateId?: string;
  workflowRunId?: string;
  schedulerRunId?: string;
  rootWorkNodeId?: string;
  workNodeId?: string;
  conflictId?: string;
  commandId?: string;
  params?: Record<string, string | number | boolean>;
  bumpIfChanged?: boolean;
  noScheduler?: boolean;
  runner?: 'opencode' | 'codex';
  workers?: string[];
  maxParallel?: number;
  acceptanceMode?: 'manual' | 'auto-reported' | 'auto-committed';
  workspaceMode?: 'shared' | 'worktree';
  opencodeBin?: string;
  codexBin?: string;
  trustProject?: boolean;
  failed?: boolean;
  timeoutSeconds?: number;
  timeoutMs?: number;
}

export interface RiveCliRunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  riveBin?: string;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  emitOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}

export interface RiveCliRunResult {
  command: string[];
  exitCode: number;
  stdoutTail: string;
  stderrTail: string;
  envelope: unknown;
}

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const TAIL_CHARS = 24_000;

export class RiveCliError extends Error {
  readonly reason: string;
  readonly command?: string[];
  readonly stdoutTail?: string;
  readonly stderrTail?: string;
  readonly envelope?: unknown;

  constructor(
    reason: string,
    message: string,
    details: {
      command?: string[];
      stdoutTail?: string;
      stderrTail?: string;
      envelope?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'RiveCliError';
    this.reason = reason;
    this.command = details.command;
    this.stdoutTail = details.stdoutTail;
    this.stderrTail = details.stderrTail;
    this.envelope = details.envelope;
  }
}

export function buildRiveCommand(input: RiveCliToolArgs): string[] {
  switch (input.action) {
    case 'workflow_validate':
      return ['workflow', 'validate', requireString(input.path, 'path')];
    case 'workflow_import': {
      const args = ['workflow', 'import', requireString(input.path, 'path'), '--command-id', requireString(input.commandId, 'commandId')];
      if (input.bumpIfChanged) args.push('--bump-if-changed');
      return args;
    }
    case 'workflow_run': {
      const args = ['workflow', 'run', requireString(input.templateId, 'templateId'), '--command-id', requireString(input.commandId, 'commandId')];
      appendParams(args, input.params);
      if (input.noScheduler) {
        args.push('--no-scheduler');
      } else {
        appendSchedulerOptions(args, input, { requireWorkers: true });
      }
      return args;
    }
    case 'workflow_status':
      return ['workflow', 'status', '--run', requireString(input.workflowRunId, 'workflowRunId')];
    case 'scheduler_status': {
      const args = ['scheduler', 'status'];
      if (input.schedulerRunId) args.push('--run', input.schedulerRunId);
      if (input.rootWorkNodeId) args.push('--root', input.rootWorkNodeId);
      if (!input.schedulerRunId && !input.rootWorkNodeId) {
        throw new RiveCliError('invalid_arguments', 'scheduler_status requires schedulerRunId or rootWorkNodeId');
      }
      return args;
    }
    case 'scheduler_resume': {
      const args = ['scheduler', 'resume', '--command-id', requireString(input.commandId, 'commandId')];
      if (input.schedulerRunId) args.push('--run', input.schedulerRunId);
      if (input.rootWorkNodeId) args.push('--root', input.rootWorkNodeId);
      if (!input.schedulerRunId && !input.rootWorkNodeId) {
        throw new RiveCliError('invalid_arguments', 'scheduler_resume requires schedulerRunId or rootWorkNodeId');
      }
      appendSchedulerOptions(args, input, { requireWorkers: false, omitRunner: true });
      if (input.failed) args.push('--failed');
      return args;
    }
    case 'work_retry': {
      const args = ['work', 'retry', requireString(input.workNodeId, 'workNodeId'), '--command-id', requireString(input.commandId, 'commandId')];
      appendSchedulerOptions(args, input, { requireWorkers: false, omitRunner: true });
      return args;
    }
    case 'branch_conflict_show':
      return ['branch', 'conflict', 'show', requireString(input.conflictId, 'conflictId')];
    default: {
      const neverAction: never = input.action;
      throw new RiveCliError('invalid_arguments', `unsupported Rive action: ${neverAction}`);
    }
  }
}

export async function runRiveCli(input: RiveCliToolArgs, options: RiveCliRunOptions): Promise<RiveCliRunResult> {
  const riveBin = await resolveRiveBinary(options.riveBin, options.env ?? process.env);
  const args = buildRiveCommand(input);
  const command = [riveBin, ...args];
  const timeoutMs = options.timeoutMs ?? input.timeoutMs ?? 600_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60 * 60 * 1000) {
    throw new RiveCliError('invalid_arguments', 'timeoutMs must be between 1ms and 1h', { command });
  }
  return await spawnRive(command, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    timeoutMs,
    abortSignal: options.abortSignal,
    emitOutput: options.emitOutput,
  });
}

export function redactRiveText(input: string): string {
  return input
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9][A-Za-z0-9_-]{8,})\b/g, '[REDACTED]')
    .replace(/\b((?:api[_-]?key|token|secret|password)\s*[:=]\s*)("[^"]+"|'[^']+'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/\b([A-Za-z0-9_-]*(?:token|secret|password|api[_-]?key)[A-Za-z0-9_-]*\s*[:=]\s*)("[^"]+"|'[^']+'|[^\s,;]+)/gi, '$1[REDACTED]');
}

export function redactRiveValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[MAX_DEPTH]';
  if (typeof value === 'string') return redactRiveText(value);
  if (Array.isArray(value)) return value.map((item) => redactRiveValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = redactRiveValue(item, depth + 1);
  }
  return out;
}

async function resolveRiveBinary(explicit: string | undefined, env: NodeJS.ProcessEnv): Promise<string> {
  const candidate = explicit || env.MAKA_RIVE_BIN || env.RIVE_BIN || 'rive';
  if (candidate.includes('/')) {
    try {
      await access(candidate, constants.X_OK);
    } catch {
      throw new RiveCliError('rive_not_installed', `Rive binary is not executable: ${candidate}`);
    }
  }
  return candidate;
}

function spawnRive(
  command: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    abortSignal?: AbortSignal;
    emitOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
  },
): Promise<RiveCliRunResult> {
  return new Promise((resolve, reject) => {
    const [bin, ...args] = command;
    const detached = process.platform !== 'win32';
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let termination: { reason: string; message: string } | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const requestTerminate = (reason: string, message: string) => {
      if (settled || termination) return;
      termination = { reason, message };
      killRiveChild(child, 'SIGTERM', detached);
      killTimer = setTimeout(() => {
        if (!settled) killRiveChild(child, 'SIGKILL', detached);
      }, 2_000);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      requestTerminate('timeout', `Rive command timed out after ${options.timeoutMs}ms`);
    }, options.timeoutMs);
    const onAbort = () => {
      requestTerminate('aborted', 'Rive command was aborted');
    };
    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.abortSignal?.removeEventListener('abort', onAbort);
    };
    options.abortSignal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      try {
        stdout = appendCapture(stdout, text);
      } catch (error) {
        requestTerminate('output_too_large', error instanceof Error ? error.message : String(error));
        return;
      }
      options.emitOutput?.('stdout', redactRiveText(text));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      try {
        stderr = appendCapture(stderr, text);
      } catch (error) {
        requestTerminate('output_too_large', error instanceof Error ? error.message : String(error));
        return;
      }
      options.emitOutput?.('stderr', redactRiveText(text));
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      const reason = error.code === 'ENOENT' ? 'rive_not_installed' : 'process_error';
      fail(new RiveCliError(reason, error.code === 'ENOENT' ? 'Rive binary was not found in PATH' : error.message, {
        command,
        stdoutTail: redactRiveText(tail(stdout)),
        stderrTail: redactRiveText(tail(stderr)),
      }));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      const stdoutTail = tail(stdout);
      const stderrTail = tail(stderr);
      const redactedStdoutTail = redactRiveText(stdoutTail);
      const redactedStderrTail = redactRiveText(stderrTail);
      if (termination) {
        reject(new RiveCliError(termination.reason, termination.message, {
          command,
          stdoutTail: redactedStdoutTail,
          stderrTail: redactedStderrTail,
        }));
        return;
      }
      let envelope: unknown;
      try {
        envelope = parseRiveJson(stdout);
      } catch (error) {
        reject(new RiveCliError('bad_json', error instanceof Error ? error.message : String(error), {
          command,
          stdoutTail: redactedStdoutTail,
          stderrTail: redactedStderrTail,
        }));
        return;
      }
      const exitCode = code ?? (signal ? 128 : 1);
      if (exitCode !== 0) {
        reject(new RiveCliError('rive_failed', riveErrorMessage(envelope, exitCode), {
          command,
          stdoutTail: redactedStdoutTail,
          stderrTail: redactedStderrTail,
          envelope: redactRiveValue(envelope),
        }));
        return;
      }
      resolve({
        command,
        exitCode,
        stdoutTail: redactedStdoutTail,
        stderrTail: redactedStderrTail,
        envelope: redactRiveValue(envelope),
      });
    });
  });
}

function killRiveChild(child: ReturnType<typeof spawn>, signal: NodeJS.Signals, detached: boolean): void {
  try {
    if (detached && typeof child.pid === 'number') {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // The process group may already be gone; fall through to direct child kill.
  }
  try {
    child.kill(signal);
  } catch {
    // Best effort termination. The close/error event is still authoritative.
  }
}

function appendCapture(current: string, chunk: string): string {
  const next = current + chunk;
  if (Buffer.byteLength(next, 'utf8') <= MAX_CAPTURE_BYTES) return next;
  throw new RiveCliError('output_too_large', `Rive output exceeded ${MAX_CAPTURE_BYTES} bytes`);
}

function tail(input: string): string {
  return input.length <= TAIL_CHARS ? input : input.slice(input.length - TAIL_CHARS);
}

function parseRiveJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error('Rive produced no JSON output');
  try {
    return JSON.parse(trimmed);
  } catch {
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    }
    throw new Error('Rive produced invalid JSON output');
  }
}

function riveErrorMessage(envelope: unknown, exitCode: number): string {
  if (envelope && typeof envelope === 'object') {
    const message = (envelope as { error?: { message?: unknown }; message?: unknown }).error?.message
      ?? (envelope as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return redactRiveText(message);
  }
  return `Rive command failed with exit code ${exitCode}`;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RiveCliError('invalid_arguments', `${name} is required`);
  }
  return value;
}

function appendParams(args: string[], params: Record<string, string | number | boolean> | undefined): void {
  if (!params) return;
  for (const [key, value] of Object.entries(params)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) {
      throw new RiveCliError('invalid_arguments', `invalid workflow param key: ${key}`);
    }
    args.push('--param', `${key}=${String(value)}`);
  }
}

function appendSchedulerOptions(
  args: string[],
  input: RiveCliToolArgs,
  options: { requireWorkers: boolean; omitRunner?: boolean },
): void {
  if (!options.omitRunner && input.runner) args.push('--runner', input.runner);
  const workers = input.workers ?? [];
  if (options.requireWorkers && workers.length === 0) {
    throw new RiveCliError('invalid_arguments', 'at least one worker is required when scheduler is enabled');
  }
  for (const worker of workers) args.push('--worker', worker);
  if (input.maxParallel !== undefined) args.push('--max-parallel', String(assertPositiveInteger(input.maxParallel, 'maxParallel')));
  if (input.acceptanceMode) args.push('--acceptance-mode', input.acceptanceMode);
  if (input.workspaceMode) args.push('--workspace-mode', input.workspaceMode);
  if (input.timeoutSeconds !== undefined) args.push('--timeout-seconds', String(assertPositiveInteger(input.timeoutSeconds, 'timeoutSeconds')));
  if (input.opencodeBin) args.push('--opencode-bin', input.opencodeBin);
  if (input.codexBin) args.push('--codex-bin', input.codexBin);
  if (input.trustProject) args.push('--trust-project');
}

function assertPositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RiveCliError('invalid_arguments', `${name} must be a positive integer`);
  }
  return value;
}
