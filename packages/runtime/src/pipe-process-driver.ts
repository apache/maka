import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';

import type { ShellSpawnPlan } from './shell-detect.js';
import {
  buildSpawnStdio,
  closeChildFdSources,
  writeChildFdInputs,
  type ChildFdInput,
} from './child-fd-input.js';
import {
  trackCapturedOutputDrain,
  type CapturedOutputDrain,
  type CapturedOutputDrainResult,
} from './child-process-lifecycle.js';

type PipeOutputStream = 'stdout' | 'stderr';

export interface PipeProcessExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface PipeProcessDriverOptions {
  plan: ShellSpawnPlan;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  fdInputs?: readonly ChildFdInput[];
  outputDrainMs: number;
  onData: (stream: 'stdout' | 'stderr', data: string) => void;
  onRootExit: () => void;
  onExit: (exit: PipeProcessExit) => void;
  onFailure: (error: Error) => void;
}

export class PipeProcessDriver {
  readonly pid: number | undefined;
  readonly ready: Promise<void>;

  private readonly child: ChildProcess;
  private readonly stdout: Readable;
  private readonly stderr: Readable;
  private readonly outputDrain: CapturedOutputDrain<PipeOutputStream>;
  private disposed = false;
  private settled = false;
  private outputDrainResult: CapturedOutputDrainResult<PipeOutputStream> | undefined;
  private rootExit: Omit<PipeProcessExit, 'stdoutTruncated' | 'stderrTruncated'> | undefined;

  constructor(private readonly options: PipeProcessDriverOptions) {
    try {
      this.child = spawn(options.plan.file, options.plan.args, {
        cwd: options.cwd,
        env: options.env,
        shell: options.plan.useShellOption,
        stdio: buildSpawnStdio(options.fdInputs),
        detached: process.platform !== 'win32',
      });
    } finally {
      closeChildFdSources(options.fdInputs);
    }
    if (!this.child.stdout || !this.child.stderr) {
      this.child.kill('SIGKILL');
      throw new Error('Pipe process did not expose stdout and stderr');
    }
    this.stdout = this.child.stdout;
    this.stderr = this.child.stderr;
    this.pid = this.child.pid;
    this.stdout.setEncoding('utf8');
    this.stderr.setEncoding('utf8');
    this.stdout.on('data', this.onStdout);
    this.stderr.on('data', this.onStderr);
    this.outputDrain = trackCapturedOutputDrain(
      [
        { key: 'stdout', stream: this.stdout },
        { key: 'stderr', stream: this.stderr },
      ],
      options.outputDrainMs,
    );
    void this.outputDrain.completion.then((result) => {
      if (this.disposed || this.settled) return;
      this.outputDrainResult = result;
      this.settleAfterDrain();
    });
    this.child.on('exit', this.onRootExit);
    this.child.on('close', this.onCloseFallback);
    this.child.on('error', this.onError);
    this.ready = waitForSpawn(this.child);
  }

  writeInputs(): void {
    writeChildFdInputs(this.child, this.options.fdInputs);
  }

  kill(signal: 'SIGTERM' | 'SIGKILL'): boolean {
    return this.child.kill(signal);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.outputDrain.dispose();
    this.stdout.off('data', this.onStdout);
    this.stderr.off('data', this.onStderr);
    this.child.off('exit', this.onRootExit);
    this.child.off('close', this.onCloseFallback);
    this.child.off('error', this.onError);
    this.stdout.destroy();
    this.stderr.destroy();
  }

  private readonly onStdout = (data: string): void => {
    if (!this.disposed && !this.settled) this.options.onData('stdout', data);
  };

  private readonly onStderr = (data: string): void => {
    if (!this.disposed && !this.settled) this.options.onData('stderr', data);
  };

  private readonly onRootExit = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
    if (this.disposed || this.rootExit) return;
    this.rootExit = { exitCode, signal };
    this.options.onRootExit();
    this.outputDrain.startDeadline();
    this.settleAfterDrain();
  };

  private readonly onCloseFallback = (
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    if (!this.rootExit) this.onRootExit(exitCode, signal);
  };

  private settleAfterDrain(): void {
    if (!this.rootExit || !this.outputDrainResult) return;
    this.settle();
  }

  private settle(): void {
    if (this.disposed || this.settled || !this.rootExit || !this.outputDrainResult) return;
    this.settled = true;
    this.options.onExit({
      ...this.rootExit,
      stdoutTruncated: this.outputDrainResult.incomplete.has('stdout'),
      stderrTruncated: this.outputDrainResult.incomplete.has('stderr'),
    });
  }

  private readonly onError = (error: Error): void => {
    if (!this.disposed && !this.settled) this.options.onFailure(error);
  };
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      child.off('spawn', onSpawn);
      child.off('error', onError);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}
