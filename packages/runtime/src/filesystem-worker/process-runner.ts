import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import {
  buildSpawnStdio,
  closeChildFdSources,
  type ChildFdInput,
  writeChildFdInputs,
} from '../child-fd-input.js';
import { DEFAULT_PROCESS_TERMINATION_GRACE_MS } from '../process-tree-terminator.js';
import {
  DEFAULT_PROCESS_IO_DRAIN_TIMEOUT_MS,
  manageChildProcessLifecycle,
} from '../child-process-lifecycle.js';

export const FILESYSTEM_WORKER_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const FILESYSTEM_WORKER_MAX_STDERR_BYTES = 1024 * 1024;
export const FILESYSTEM_WORKER_DEFAULT_TIMEOUT_MS = 120_000;

export interface FilesystemWorkerProcessRunInput {
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  stdin: string;
  fdInputs?: readonly ChildFdInput[];
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  maxResponseBytes?: number;
  maxStderrBytes?: number;
  killGraceMs?: number;
  ioDrainTimeoutMs?: number;
}

export interface FilesystemWorkerProcessRunResult {
  exitCode: number;
  stdout: string;
  stderrTail: string;
  timedOut: boolean;
  aborted: boolean;
  responseOverflow: boolean;
}

export type FilesystemWorkerProcessRunner = (
  input: FilesystemWorkerProcessRunInput,
) => Promise<FilesystemWorkerProcessRunResult>;

type WorkerChildProcess = ChildProcessByStdio<Writable, Readable, Readable>;

export async function runFilesystemWorkerProcess(
  input: FilesystemWorkerProcessRunInput,
): Promise<FilesystemWorkerProcessRunResult> {
  const program = input.argv[0];
  if (!program) throw new Error('Filesystem worker argv must include a program.');
  if (input.abortSignal?.aborted) {
    closeChildFdSources(input.fdInputs);
    return {
      exitCode: 1,
      stdout: '',
      stderrTail: '',
      timedOut: false,
      aborted: true,
      responseOverflow: false,
    };
  }
  let child: WorkerChildProcess;
  try {
    child = spawn(program, input.argv.slice(1), {
      cwd: input.cwd,
      env: input.env as NodeJS.ProcessEnv,
      shell: false,
      stdio: buildSpawnStdio(input.fdInputs, 'pipe'),
      detached: process.platform !== 'win32',
    }) as WorkerChildProcess;
  } finally {
    closeChildFdSources(input.fdInputs);
  }
  return await observeWorker(child, input);
}

async function observeWorker(
  child: WorkerChildProcess,
  input: FilesystemWorkerProcessRunInput,
): Promise<FilesystemWorkerProcessRunResult> {
  return await new Promise((resolvePromise, reject) => {
    const responseLimit = input.maxResponseBytes ?? FILESYSTEM_WORKER_MAX_RESPONSE_BYTES;
    const stderrLimit = input.maxStderrBytes ?? FILESYSTEM_WORKER_MAX_STDERR_BYTES;
    const timeoutMs = input.timeoutMs ?? FILESYSTEM_WORKER_DEFAULT_TIMEOUT_MS;
    const killGraceMs = input.killGraceMs ?? DEFAULT_PROCESS_TERMINATION_GRACE_MS;
    const ioDrainTimeoutMs = input.ioDrainTimeoutMs ?? DEFAULT_PROCESS_IO_DRAIN_TIMEOUT_MS;
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let responseOverflow = false;
    let termination: 'timeout' | 'abort' | 'overflow' | undefined;
    let settled = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (responseOverflow) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > responseLimit) {
        responseOverflow = true;
        stdoutChunks.length = 0;
        terminate('overflow');
      } else {
        stdoutChunks.push(chunk);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = appendBoundedTail(stderrTail, chunk, stderrLimit);
    });
    const lifecycle = manageChildProcessLifecycle(
      child,
      [
        { key: 'stdout', stream: child.stdout },
        { key: 'stderr', stream: child.stderr },
      ],
      {
        killGraceMs,
        ioDrainTimeoutMs,
      },
    );
    void lifecycle.completion.then((outcome) => {
      if (settled) return;
      if (!outcome.ioDrained) {
        rejectOnce(new Error('Filesystem worker output did not drain before lifecycle deadline'));
        return;
      }
      settled = true;
      cleanup();
      resolvePromise({
        exitCode: outcome.exitCode ?? 1,
        stdout: responseOverflow ? '' : Buffer.concat(stdoutChunks).toString('utf8'),
        stderrTail: stderrTail.toString('utf8'),
        timedOut: termination === 'timeout',
        aborted: termination === 'abort',
        responseOverflow,
      });
    }, rejectOnce);
    const timeout = setTimeout(() => terminate('timeout'), timeoutMs);
    const abort = () => terminate('abort');
    if (input.abortSignal) {
      if (input.abortSignal.aborted) abort();
      else input.abortSignal.addEventListener('abort', abort, { once: true });
    }
    child.stdin.once('error', () => {});
    try {
      writeChildFdInputs(child, input.fdInputs);
    } catch (error) {
      settled = true;
      cleanup();
      lifecycle.forceKill();
      reject(error);
      return;
    }
    child.stdin.end(input.stdin);

    function terminate(reason: 'timeout' | 'abort' | 'overflow'): void {
      if (termination || settled) return;
      termination = reason;
      lifecycle.terminate();
    }

    function rejectOnce(error: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }

    function cleanup(): void {
      clearTimeout(timeout);
      input.abortSignal?.removeEventListener('abort', abort);
    }
  });
}

function appendBoundedTail(current: Buffer, chunk: Buffer, limit: number): Buffer {
  if (limit <= 0) return Buffer.alloc(0);
  if (chunk.length >= limit) return chunk.subarray(chunk.length - limit);
  if (current.length + chunk.length <= limit) return Buffer.concat([current, chunk]);
  return Buffer.concat([current.subarray(current.length - (limit - chunk.length)), chunk]);
}
