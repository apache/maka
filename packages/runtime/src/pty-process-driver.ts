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

  constructor(options: PtyProcessDriverOptions) {
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
    this.pty.write(data);
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
