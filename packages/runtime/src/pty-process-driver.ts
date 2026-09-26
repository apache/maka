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

import { writeSync } from 'node:fs';
import type { IDisposable, IPty } from 'node-pty';

import type { PtyStack } from './pty-stack.js';

export interface PtyProcessExit {
  exitCode: number;
  signal?: number;
}

export interface PtyProcessDriverOptions {
  stack: PtyStack;
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
  onData: (data: string) => void;
  onExit: (exit: PtyProcessExit) => void;
  onInvariantFailure: (error: Error) => void;
}

export class PtyProcessDriver {
  private readonly pty: IPty;
  private readonly subscriptions: IDisposable[];
  private exited = false;
  private disposed = false;
  // Own the Unix write queue so a control handoff can fence every actual write.
  // node-pty's void write() only acknowledges admission to its private queue.
  private readonly writes: Array<{ buffer: Buffer; offset: number }> = [];
  private queuedBytes = 0;
  private writeTimer?: ReturnType<typeof setTimeout>;
  private writeFailure?: Error;
  private readonly drains = new Set<{ resolve(): void; reject(error: Error): void }>();
  private readonly onWriteFailure: (error: Error) => void;

  constructor(options: PtyProcessDriverOptions) {
    this.onWriteFailure = options.onInvariantFailure;
    const env = { ...options.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    const pty = options.stack.spawn(options.file, options.args, {
      cwd: options.cwd,
      env,
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      encoding: 'utf8',
      handleFlowControl: false,
    });
    this.pty = pty;
    const subscriptions: IDisposable[] = [];
    try {
      subscriptions.push(
        pty.onData((data) => {
          if (this.disposed) return;
          if (this.exited) {
            options.onInvariantFailure(new Error('node-pty emitted data after its exit fence'));
            return;
          }
          options.onData(data);
        }),
      );
      subscriptions.push(
        pty.onExit((exit) => {
          if (this.disposed || this.exited) return;
          this.exited = true;
          this.closeWrites();
          options.onExit(exit);
        }),
      );
    } catch (error) {
      for (const subscription of subscriptions) {
        try {
          subscription.dispose();
        } catch {
          /* startup cleanup continues */
        }
      }
      try {
        killPty(pty, 'SIGKILL');
      } catch {
        /* startup cleanup continues */
      }
      throw error;
    }
    this.subscriptions = subscriptions;
  }

  get pid(): number {
    // ConPTY publishes its inner PID after construction; never cache the initial 0.
    return this.pty.pid;
  }

  write(data: string): void {
    if (this.writeFailure) throw this.writeFailure;
    if (this.exited || this.disposed) throw new Error('PTY input is closed');
    if (!this.supportsInputFence) {
      this.pty.write(data);
      return;
    }
    const buffer = Buffer.from(data, 'utf8');
    if (this.queuedBytes + buffer.length > 2 * 1024 * 1024) {
      throw new Error('PTY input queue capacity exceeded');
    }
    this.writes.push({ buffer, offset: 0 });
    this.queuedBytes += buffer.length;
    this.flushWrites();
  }

  get supportsInputFence(): boolean {
    return process.platform !== 'win32' && Number.isInteger(this.unixFd);
  }

  /** Wait for admitted bytes to reach the OS, not for the child to consume them. */
  async drainInput(signal: AbortSignal): Promise<void> {
    if (this.writeFailure) throw this.writeFailure;
    if (!this.supportsInputFence)
      throw new Error('PTY input fencing is unavailable on this platform');
    if (signal.aborted) throw new Error('PTY input fence cancelled');
    if (this.exited || this.disposed) throw new Error('PTY input is closed');
    if (this.writes.length === 0) return;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        signal.removeEventListener('abort', abort);
        this.drains.delete(waiter);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(new Error('PTY input fence cancelled'));
      const waiter = { resolve: () => finish(), reject: (error: Error) => finish(error) };
      this.drains.add(waiter);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  private get unixFd(): number | undefined {
    return (this.pty as IPty & { fd?: number }).fd;
  }

  private flushWrites(): void {
    if (this.writeTimer || this.exited || this.disposed) return;
    const fd = this.unixFd;
    if (fd === undefined) return;
    // A synchronous nonblocking write cannot outlive this PTY's fd ownership.
    // Yield under backpressure and between bounded batches, never in the write.
    let budget = 64 * 1024;
    try {
      while (this.writes.length && budget > 0) {
        const entry = this.writes[0]!;
        const length = Math.min(entry.buffer.length - entry.offset, budget);
        if (length === 0) {
          this.writes.shift();
          continue;
        }
        const written = writeSync(fd, entry.buffer, entry.offset, length);
        if (written === 0) break;
        entry.offset += written;
        this.queuedBytes -= written;
        budget -= written;
        if (entry.offset === entry.buffer.length) this.writes.shift();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EAGAIN' && code !== 'EWOULDBLOCK' && code !== 'EINTR') {
        this.writeFailure = new Error('PTY input delivery failed');
        this.closeWrites();
        this.onWriteFailure(this.writeFailure);
        return;
      }
    }
    if (this.writes.length) {
      this.writeTimer = setTimeout(() => {
        this.writeTimer = undefined;
        this.flushWrites();
      }, 1);
    } else {
      for (const waiter of [...this.drains]) waiter.resolve();
    }
  }

  private closeWrites(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = undefined;
    this.writes.length = 0;
    this.queuedBytes = 0;
    for (const waiter of [...this.drains])
      waiter.reject(new Error('PTY input closed before delivery'));
  }

  resize(cols: number, rows: number): void {
    this.pty.resize(cols, rows);
  }

  kill(signal: 'SIGTERM' | 'SIGKILL'): void {
    killPty(this.pty, signal);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closeWrites();
    for (const subscription of this.subscriptions) {
      try {
        subscription.dispose();
      } catch {
        // Subscription cleanup is best-effort and must remain idempotent.
      }
    }
  }
}

function killPty(pty: IPty, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (process.platform === 'win32') {
    pty.kill();
    return;
  }
  pty.kill(signal);
}
