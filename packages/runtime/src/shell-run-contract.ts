import {
  encodedTerminalInputActionsByteLength,
  isWellFormedTerminalInput,
  parseTerminalInputAction,
  type TerminalInputAction,
} from '@maka/core/terminal-input';

import { isShellRunId, SHELL_RUN_ID_MAX_CHARS, type ShellRunStore } from '@maka/core/shell-run';

import { type ShellRunUpdate, type ToolResultContent } from '@maka/core/events';

import type { ShellPlan } from './shell-detect.js';
import type { ChildFdInput } from './child-fd-input.js';
import type { SandboxType } from './sandbox/types.js';

export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
export const MAX_FOREGROUND_BASH_TIMEOUT_MS = 10 * 60 * 1_000;
export const MAX_WRITE_STDIN_INPUT_BYTES = 64 * 1024;
export const MAX_WRITE_STDIN_ACTIONS = 64;
export const MIN_PTY_COLS = 2;
export const MAX_PTY_COLS = 240;
export const MIN_PTY_ROWS = 1;
export const MAX_PTY_ROWS = 100;
export const MAX_SHELL_RUN_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_LIVE_SHELL_RUNS = 64;
export const DEFAULT_MAX_LIVE_PTY_RUNS = 8;
export const DEFAULT_SHELL_RUN_FLUSH_INTERVAL_MS = 1_000;
export const DEFAULT_SHELL_RUN_FLUSH_BYTES = 64 * 1024;
export const DEFAULT_PIPE_OUTPUT_DRAIN_MS = 2_000;
export const SHELL_RUN_CONTEXT_SUMMARY_LIMIT = 8;
export const SHELL_RUN_RESOURCE_PREFIX = 'maka://runtime/background-tasks';
export const MAX_SHELL_RUN_RESOURCE_REF_CHARS =
  SHELL_RUN_RESOURCE_PREFIX.length + 1 + SHELL_RUN_ID_MAX_CHARS;

export { isWellFormedTerminalInput };

const SHELL_RUN_RESOURCE_PATH_PATTERN = /^\/background-tasks\/([^/]+)$/;

type ShellRunToolResult = Extract<ToolResultContent, { kind: 'shell_run' }>;

export class ShellRunPtyControlClosedError extends Error {
  constructor() {
    super('This PTY is stopping and no longer accepts input; use Read to observe its final state');
    this.name = 'ShellRunPtyControlClosedError';
  }
}

export interface ShellRunProcessManagerInput {
  store: ShellRunStore;
  newId: () => string;
  now: () => number;
  onShellRunUpdate?: (update: ShellRunUpdate) => void;
  onPtyData?: (event: ShellRunPtyDataEvent) => void;
  maxLiveShellRuns?: number;
  maxLivePtyRuns?: number;
  flushIntervalMs?: number;
  flushBytes?: number;
  maxRetainedChars?: number;
  maxLiveEmitChars?: number;
  killGraceMs?: number;
  exitAcknowledgementMs?: number;
  pipeOutputDrainMs?: number;
  /** Schedules the automatic durable flush and returns its canceler; injected so tests can drive flush timing. */
  scheduleFlush?: (run: () => void, delayMs: number) => () => void;
  /** Schedules the run timeout and returns its canceler; injected so tests can drive timeout timing. */
  scheduleTimeout?: (run: () => void, delayMs: number) => () => void;
}

export interface ShellRunBashInput {
  sessionId: string;
  sourceRunId?: string;
  sourceTurnId: string;
  sourceToolCallId: string;
  cwd: string;
  command: string;
  /** Final executable argv. When present, bypasses host-shell parsing. */
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** Binary payloads exposed to pipe-mode children on inherited descriptors. */
  fdInputs?: readonly ChildFdInput[];
  pty?: boolean;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  emitOutput: (stream: 'stdout' | 'stderr', chunk: string) => void;
  shell?: ShellPlan;
  /** Effective command sandbox selected before process launch. */
  sandboxType?: SandboxType;
  /** Invoked exactly once after startup failure or terminal process completion. */
  onCompletion?: (outcome: { successful: boolean }) => void;
}

export interface ShellRunWriteInput {
  sessionId: string;
  ref: string;
  input?: string;
  actions?: readonly TerminalInputAction[];
  size?: { cols: number; rows: number };
  abortSignal?: AbortSignal;
}

export interface ShellRunPtyDataEvent {
  sessionId: string;
  ref: string;
  sequence: number;
  data: string;
}

export interface ShellRunPtySnapshot {
  sessionId: string;
  ref: string;
  sequence: number;
  buffer: string;
  size: { cols: number; rows: number };
}

export interface RuntimeResourceReader {
  readRuntimeResource(
    sessionId: string,
    ref: string,
    abortSignal: AbortSignal,
  ): Promise<ToolResultContent>;
}

export interface BackgroundTaskStopper {
  stopBackgroundTask(
    sessionId: string,
    ref: string,
    abortSignal: AbortSignal,
  ): Promise<ToolResultContent>;
}

export interface PtyControlWriter {
  writeStdin(input: ShellRunWriteInput): Promise<ShellRunToolResult>;
}

export function validateWriteStdinInput(input: ShellRunWriteInput): void {
  if (input.input !== undefined && input.actions !== undefined) {
    throw new Error('WriteStdin raw input and terminal actions are mutually exclusive');
  }
  if (input.input === undefined && input.actions === undefined && input.size === undefined) {
    throw new Error('WriteStdin requires input, actions, and/or size');
  }
  if (input.input !== undefined) {
    if (input.input.length === 0) throw new Error('WriteStdin input must not be empty');
    if (!isWellFormedTerminalInput(input.input))
      throw new Error('WriteStdin input must be well-formed Unicode');
    const bytes = Buffer.byteLength(input.input, 'utf8');
    if (bytes > MAX_WRITE_STDIN_INPUT_BYTES) {
      throw new Error(`WriteStdin input exceeds the ${MAX_WRITE_STDIN_INPUT_BYTES}-byte limit`);
    }
  }
  if (input.actions !== undefined) validateTerminalInputActions(input.actions);
  if (input.size) {
    if (
      !Number.isInteger(input.size.cols) ||
      input.size.cols < MIN_PTY_COLS ||
      input.size.cols > MAX_PTY_COLS
    ) {
      throw new Error(`WriteStdin cols must be between ${MIN_PTY_COLS} and ${MAX_PTY_COLS}`);
    }
    if (
      !Number.isInteger(input.size.rows) ||
      input.size.rows < MIN_PTY_ROWS ||
      input.size.rows > MAX_PTY_ROWS
    ) {
      throw new Error(`WriteStdin rows must be between ${MIN_PTY_ROWS} and ${MAX_PTY_ROWS}`);
    }
  }
}

function validateTerminalInputActions(actions: readonly TerminalInputAction[]): void {
  if (actions.length === 0) throw new Error('WriteStdin actions must not be empty');
  if (actions.length > MAX_WRITE_STDIN_ACTIONS) {
    throw new Error(`WriteStdin actions must not exceed ${MAX_WRITE_STDIN_ACTIONS} entries`);
  }
  for (const action of actions) {
    parseTerminalInputAction(action);
  }
  if (encodedTerminalInputActionsByteLength(actions) > MAX_WRITE_STDIN_INPUT_BYTES) {
    throw new Error(`WriteStdin actions exceed the ${MAX_WRITE_STDIN_INPUT_BYTES}-byte limit`);
  }
}

export function shellRunResourceRef(shellRunId: string): string {
  if (!isShellRunId(shellRunId)) throw new Error('Invalid shell run id');
  return `${SHELL_RUN_RESOURCE_PREFIX}/${encodeURIComponent(shellRunId)}`;
}

export function isShellRunResourceRef(ref: string): boolean {
  return parseShellRunResourceRef(ref) !== null;
}

export function parseShellRunResourceRef(ref: string): { shellRunId: string } | null {
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'maka:' ||
    url.hostname !== 'runtime' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    return null;
  const match = SHELL_RUN_RESOURCE_PATH_PATTERN.exec(url.pathname);
  if (!match) return null;
  const encodedId = match[1];
  if (!encodedId) return null;
  try {
    const shellRunId = decodeURIComponent(encodedId);
    if (!isShellRunId(shellRunId) || ref !== shellRunResourceRef(shellRunId)) return null;
    return { shellRunId };
  } catch {
    return null;
  }
}
