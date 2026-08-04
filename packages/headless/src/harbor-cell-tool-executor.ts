// Tool executors and subprocess helpers for the Harbor cell. This leaf owns the
// isolated tool execution surface: the HTTP bridge executor, the local subprocess
// executor (bounded-tail shell + secret-stripped child env), and the ai-sdk tool
// list. Splitting it out of the orchestration module keeps node:child_process and
// the shell plumbing in one place.
import { exec as nodeExec } from 'node:child_process';
import { promisify } from 'node:util';
import { defaultShellPlan, runShellWithBoundedTail, type MakaTool } from '@maka/runtime';
import { Agent, fetch as undiciFetch } from 'undici';
import { numericEnv, type RunHarborCellEnv } from './headless-run-env.js';
import type { IsolatedCommandResult, IsolatedToolExecutor } from './isolation.js';
import { isSensitiveEnvName } from './provider-env.js';
import {
  buildIsolatedHeadlessTools,
  FRAMED_FILE_TOOL_MAX_TRANSPORT_BYTES,
  type BuildIsolatedHeadlessToolsOptions,
} from './tools.js';

const execAsync = promisify(nodeExec);

// Container mode's fallback when no command and no operator asks for a timeout.
// Its host-cell counterpart is maka_agent.py's _BRIDGE_DEFAULT_TIMEOUT_SEC: two
// enforcers in two processes, so two constants, but the same cell must not be
// killed at different times depending on which isolation mode ran it. Change
// both or neither.
export const HARBOR_CELL_DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

// The bridge returns response headers only after the isolated command exits.
// Leave command duration to its timeout and the active tool's abort signal.
const harborHttpDispatcher = new Agent({ headersTimeout: 0 });

export function buildHarborCellAiSdkTools(
  executor: IsolatedToolExecutor,
  options: BuildIsolatedHeadlessToolsOptions = {},
): MakaTool[] {
  return buildIsolatedHeadlessTools(executor, options);
}

export function createHarborHttpToolExecutor(
  env: RunHarborCellEnv = process.env,
  fetchImpl: typeof undiciFetch = undiciFetch,
): IsolatedToolExecutor {
  const baseUrl = requiredHarborEnv(env, 'MAKA_HARBOR_TOOL_EXECUTOR_URL');
  const token = requiredHarborEnv(env, 'MAKA_HARBOR_TOOL_EXECUTOR_TOKEN');
  // The same floor the local executor applies, for the same reason: a task that
  // builds or tests for longer than the default must be able to say so once
  // instead of losing every command to it. Left unread, this env var worked in
  // container mode and was silently inert in host-cell mode — the adapter
  // forwards it either way. Unset stays unset so the bridge's own default
  // (maka_agent.py _BRIDGE_DEFAULT_TIMEOUT_SEC) remains the single fallback.
  const operatorDefaultTimeoutMs = numericEnv(env.MAKA_CELL_COMMAND_TIMEOUT_MS);
  return {
    exec: async (input, control) => {
      // timeoutMs is the field the bridge reads (maka_agent.py _ToolExecutorServer
      // takes payload["timeoutMs"]); the timeoutSec that used to ride alongside it
      // was never read by anything, and sitting next to the live field is how the
      // env var above looked handled while doing nothing.
      const timeoutMs = input.timeoutMs ?? operatorDefaultTimeoutMs;
      const response = await fetchImpl(new URL('/exec', baseUrl), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...input,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        }),
        signal: control?.abortSignal,
        dispatcher: harborHttpDispatcher,
      });
      const body = await response.text();
      if (!response.ok) {
        throw new Error(
          `Harbor tool executor failed: ${harborBridgeErrorMessage(body, response.status)}`,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new Error('Harbor tool executor returned an invalid response');
      }
      return decodeHarborCommandResult(parsed);
    },
  };
}

function decodeHarborCommandResult(parsed: unknown): IsolatedCommandResult {
  if (!isRecord(parsed)) throw invalidHarborResponse();
  const { exitCode, returnCode } = parsed;
  if (
    (exitCode !== undefined && (typeof exitCode !== 'number' || !Number.isSafeInteger(exitCode))) ||
    (returnCode !== undefined &&
      (typeof returnCode !== 'number' || !Number.isSafeInteger(returnCode))) ||
    (exitCode === undefined && returnCode === undefined) ||
    (exitCode !== undefined && returnCode !== undefined && exitCode !== returnCode) ||
    typeof parsed.stdout !== 'string' ||
    typeof parsed.stderr !== 'string' ||
    (parsed.timedOut !== undefined && typeof parsed.timedOut !== 'boolean') ||
    (parsed.timedOut === true && (exitCode ?? returnCode) !== 124)
  ) {
    throw invalidHarborResponse();
  }
  return {
    exitCode: (exitCode ?? returnCode) as number,
    stdout: parsed.stdout,
    stderr: parsed.stderr,
    ...(parsed.timedOut !== undefined ? { timedOut: parsed.timedOut } : {}),
  };
}

function invalidHarborResponse(): Error {
  return new Error('Harbor tool executor returned an invalid response');
}

export function createHarborCellLocalToolExecutor(
  env: RunHarborCellEnv = process.env,
): IsolatedToolExecutor {
  const childEnv = childProcessEnv(env);
  // A command that does not request its own timeout falls back to this. Some
  // Terminal-Bench tasks build or test for longer than the 2-minute default, so
  // the floor is operator-configurable instead of a hard-coded failure source.
  const defaultTimeoutMs =
    numericEnv(env.MAKA_CELL_COMMAND_TIMEOUT_MS) ?? HARBOR_CELL_DEFAULT_COMMAND_TIMEOUT_MS;
  // The shell this executor spawns in (PowerShell on Windows). Exposed as
  // `shell` so buildIsolatedBashTool DECLARES the dialect to the model, and
  // passed to runShellWithBoundedTail so the declaration matches execution —
  // selection without declaration is the original Windows bug (shell-detect.ts).
  const shell = defaultShellPlan();
  return {
    shell,
    exec: async ({ command, cwd, timeoutMs, boundedTail }, control) => {
      if (boundedTail) {
        // Bash opted in: stream into a bounded tail (shared with the in-process
        // builtin Bash) instead of execAsync({ maxBuffer }). A command whose
        // output passes 10MB is no longer KILLED with only its head returned —
        // it runs to completion and we keep the last ~1MB (the recoverable tail).
        try {
          const result = await runShellWithBoundedTail(command, {
            cwd,
            env: childEnv,
            timeoutMs: timeoutMs ?? defaultTimeoutMs,
            abortSignal: control?.abortSignal,
            shell,
          });
          return {
            exitCode: result.timedOut ? 124 : result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            stdoutTruncated: result.stdoutTruncated,
            stderrTruncated: result.stderrTruncated,
            timedOut: result.timedOut,
          };
        } catch (error) {
          // runShellWithBoundedTail only rejects when the process cannot be
          // spawned at all (e.g. the shell binary is missing).
          return {
            exitCode: shellErrorExitCode(error),
            stdout: shellErrorText(error, 'stdout'),
            stderr: shellErrorText(error, 'stderr') || shellErrorMessage(error),
          };
        }
      }
      // Default (Read/Glob/Grep/Edit fallbacks): FULL output up to the buffer
      // cap. These must return complete, head-first content — a bounded tail
      // would silently drop the head of a file or search result and the model
      // would edit code from a partial view.
      try {
        const result = await execAsync(command, {
          cwd,
          env: childEnv,
          timeout: timeoutMs ?? defaultTimeoutMs,
          maxBuffer: FRAMED_FILE_TOOL_MAX_TRANSPORT_BYTES,
          signal: control?.abortSignal,
        });
        return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        return {
          exitCode: shellErrorExitCode(error),
          stdout: shellErrorText(error, 'stdout'),
          stderr: shellErrorText(error, 'stderr') || shellErrorMessage(error),
          ...(shellErrorTimedOut(error) ? { timedOut: true } : {}),
        };
      }
    },
  };
}

function harborBridgeErrorMessage(body: string, status: number): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed) && typeof parsed.error === 'string' && parsed.error.trim()) {
      return parsed.error.trim();
    }
  } catch {
    // The bridge response is untrusted transport data; do not expose it as command stderr.
  }
  return `HTTP ${status}`;
}

function requiredHarborEnv(env: RunHarborCellEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function childProcessEnv(env: RunHarborCellEnv): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) childEnv[key] = value;
  }
  for (const key of Object.keys(childEnv)) {
    if (isSensitiveEnvName(key)) {
      delete childEnv[key];
    }
  }
  return childEnv;
}

function shellErrorExitCode(error: unknown): number {
  if (isRecord(error) && typeof error.code === 'number') return error.code;
  if (isRecord(error) && typeof error.signal === 'string') return 124;
  return 1;
}

function shellErrorTimedOut(error: unknown): boolean {
  return (
    isRecord(error) &&
    error.killed === true &&
    typeof error.signal === 'string' &&
    error.name !== 'AbortError' &&
    error.code !== 'ABORT_ERR'
  );
}

function shellErrorText(error: unknown, field: 'stdout' | 'stderr'): string {
  if (isRecord(error) && typeof error[field] === 'string') return error[field];
  return '';
}

function shellErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
