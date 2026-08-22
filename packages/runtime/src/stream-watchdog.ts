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

export const DEFAULT_STREAM_CONNECT_TIMEOUT_MS = 30_000;
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;

export type StreamWatchdogPhase = 'connect' | 'idle';

export interface StreamWatchdogTimeout {
  phase: StreamWatchdogPhase;
  elapsedMs: number;
}

export interface StreamWatchdogInput {
  now: () => number;
  onTimeout: (timeout: StreamWatchdogTimeout) => void;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/**
 * Small watchdog for LLM streams.
 *
 * It has two phases:
 * - connect: no model/tool event has arrived yet.
 * - idle: at least one event arrived, then the stream went quiet.
 *
 * Permission waits are paused by the backend, because user approval is not
 * model silence.
 */
export class StreamWatchdog {
  private readonly now: () => number;
  private readonly onTimeout: (timeout: StreamWatchdogTimeout) => void;
  private readonly connectTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;

  private startedAt = 0;
  private lastActivityAt = 0;
  private sawActivity = false;
  private pauseCount = 0;
  private stopped = false;
  private timer: unknown;

  constructor(input: StreamWatchdogInput) {
    this.now = input.now;
    this.onTimeout = input.onTimeout;
    this.connectTimeoutMs = input.connectTimeoutMs ?? DEFAULT_STREAM_CONNECT_TIMEOUT_MS;
    this.idleTimeoutMs = input.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    this.setTimer = input.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer =
      input.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  start(): void {
    if (this.stopped) return;
    const now = this.now();
    this.startedAt = now;
    this.lastActivityAt = now;
    this.sawActivity = false;
    this.pauseCount = 0;
    this.schedule(this.connectTimeoutMs);
  }

  markActivity(): void {
    if (this.stopped) return;
    this.sawActivity = true;
    this.lastActivityAt = this.now();
    if (this.pauseCount === 0) this.schedule(this.idleTimeoutMs);
  }

  pause(): void {
    if (this.stopped) return;
    this.pauseCount += 1;
    this.clear();
  }

  resume(): void {
    if (this.stopped) return;
    this.pauseCount = Math.max(0, this.pauseCount - 1);
    if (this.pauseCount > 0) return;
    this.markActivity();
  }

  stop(): void {
    this.stopped = true;
    this.clear();
  }

  private schedule(delayMs: number): void {
    this.clear();
    if (delayMs <= 0) return;
    this.timer = this.setTimer(() => this.fire(), delayMs);
  }

  private clear(): void {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  private fire(): void {
    if (this.stopped || this.pauseCount > 0) return;
    this.stopped = true;
    this.clear();
    const phase: StreamWatchdogPhase = this.sawActivity ? 'idle' : 'connect';
    const anchor = this.sawActivity ? this.lastActivityAt : this.startedAt;
    this.onTimeout({
      phase,
      elapsedMs: Math.max(0, this.now() - anchor),
    });
  }
}

export function formatStreamWatchdogError(timeout: StreamWatchdogTimeout): string {
  if (timeout.phase === 'connect') {
    return `Model stream connect timeout after ${timeout.elapsedMs}ms`;
  }
  return `Model stream idle timeout after ${timeout.elapsedMs}ms`;
}
