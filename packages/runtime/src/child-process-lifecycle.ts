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

import type { ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';

import {
  DEFAULT_PROCESS_TERMINATION_GRACE_MS,
  terminateChildProcessTree,
} from './process-tree-terminator.js';

export const DEFAULT_PROCESS_IO_DRAIN_TIMEOUT_MS = DEFAULT_PROCESS_TERMINATION_GRACE_MS;

export interface ChildProcessLifecycleResult<OutputKey extends PropertyKey = number> {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** False when local capture streams were destroyed at the I/O deadline. */
  ioDrained: boolean;
  incompleteOutputs: ReadonlySet<OutputKey>;
}

export interface ChildProcessLifecycle<OutputKey extends PropertyKey = number> {
  completion: Promise<ChildProcessLifecycleResult<OutputKey>>;
  terminate(): void;
  forceKill(): void;
}

export interface CapturedOutput<Key extends PropertyKey> {
  key: Key;
  stream: Readable;
}

export interface CapturedOutputDrainResult<Key extends PropertyKey> {
  incomplete: ReadonlySet<Key>;
}

export interface CapturedOutputDrain<Key extends PropertyKey> {
  completion: Promise<CapturedOutputDrainResult<Key>>;
  startDeadline(): void;
  dispose(): void;
}

interface ChildProcessLifecycleOptions {
  killGraceMs: number;
  ioDrainTimeoutMs: number;
  exitAcknowledgementMs?: number;
  /** Narrow test seam for an OS outcome that cannot be induced reliably. */
  signalProcessTree?: (signal: 'SIGTERM' | 'SIGKILL') => Promise<boolean>;
}

interface CapturedOutputState {
  stream: Readable;
  ended: boolean;
  onEnd: () => void;
  onClose: () => void;
  onError: () => void;
}

/**
 * Owns the one captured-output completion policy shared by retained and
 * one-shot child processes. Only a normal `end` is complete; premature
 * `close`, stream `error`, and deadline destruction are incomplete.
 */
export function trackCapturedOutputDrain<Key extends PropertyKey>(
  outputs: readonly CapturedOutput<Key>[],
  timeoutMs: number,
): CapturedOutputDrain<Key> {
  const states = new Map<Key, CapturedOutputState>();
  const pending = new Set<Key>();
  const incomplete = new Set<Key>();
  let started = false;
  let completed = false;
  let timer: NodeJS.Timeout | undefined;
  let resolveCompletion!: (result: CapturedOutputDrainResult<Key>) => void;
  const completion = new Promise<CapturedOutputDrainResult<Key>>((resolve) => {
    resolveCompletion = resolve;
  });

  for (const { key, stream } of outputs) {
    const state: CapturedOutputState = {
      stream,
      ended: stream.readableEnded,
      onEnd: () => settleStream(key, 'end'),
      onClose: () => settleStream(key, 'close'),
      onError: () => settleStream(key, 'error'),
    };
    if (states.has(key)) throw new Error(`Duplicate captured output key: ${String(key)}`);
    states.set(key, state);
    if (stream.destroyed && !stream.readableEnded) incomplete.add(key);
    if (!stream.readableEnded && !stream.destroyed) pending.add(key);
    stream.on('end', state.onEnd);
    stream.on('close', state.onClose);
    stream.on('error', state.onError);
  }

  function startDeadline(): void {
    if (completed || started) return;
    started = true;
    if (pending.size === 0) {
      finish();
      return;
    }
    timer = setTimeout(expire, timeoutMs);
  }

  function settleStream(key: Key, event: 'end' | 'close' | 'error'): void {
    if (completed) return;
    const state = states.get(key);
    if (!state) return;
    if (event === 'end') state.ended = true;
    if (event === 'error' || (event === 'close' && !state.ended)) incomplete.add(key);
    pending.delete(key);
    if (started && pending.size === 0) finish();
  }

  function expire(): void {
    timer = undefined;
    for (const key of [...pending]) {
      const state = states.get(key);
      if (!state) continue;
      incomplete.add(key);
      pending.delete(key);
      state.stream.destroy();
    }
    finish();
  }

  function dispose(): void {
    if (completed) return;
    started = true;
    expire();
  }

  function finish(): void {
    if (completed || !started || pending.size > 0) return;
    completed = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    for (const state of states.values()) {
      state.stream.off('end', state.onEnd);
      state.stream.off('close', state.onClose);
      state.stream.off('error', state.onError);
    }
    resolveCompletion({ incomplete: new Set(incomplete) });
  }

  return { completion, startDeadline, dispose };
}

/**
 * Tracks direct-root exit separately from captured stream drain. An escaped
 * descendant can retain an inherited writer after the root exits, so
 * ChildProcess `close` is not a safe completion boundary by itself.
 */
export function manageChildProcessLifecycle<OutputKey extends PropertyKey>(
  child: ChildProcess,
  outputs: readonly CapturedOutput<OutputKey>[],
  options: ChildProcessLifecycleOptions,
): ChildProcessLifecycle<OutputKey> {
  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  let rootExited = false;
  let ioDrainTimedOut = false;
  let settled = false;
  let terminationStarted = false;
  let killSent = false;
  let signalsInFlight = 0;
  let killTimer: NodeJS.Timeout | undefined;
  let exitAcknowledgementTimer: NodeJS.Timeout | undefined;
  let outputDrainResult: CapturedOutputDrainResult<OutputKey> | undefined;
  const outputDrain = trackCapturedOutputDrain(outputs, options.ioDrainTimeoutMs);

  let resolveCompletion!: (result: ChildProcessLifecycleResult<OutputKey>) => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<ChildProcessLifecycleResult<OutputKey>>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  void outputDrain.completion.then((result) => {
    outputDrainResult = result;
    ioDrainTimedOut = result.incomplete.size > 0;
    maybeFinish();
  });

  const onExit = (code: number | null, exitSignal: NodeJS.Signals | null) => {
    if (settled) return;
    rootExited = true;
    exitCode = code;
    signal = exitSignal;
    if (exitAcknowledgementTimer) clearTimeout(exitAcknowledgementTimer);
    outputDrain.startDeadline();
    maybeFinish();
  };
  const onError = (error: Error) => {
    if (settled) return;
    outputDrain.dispose();
    fail(error);
  };

  child.once('exit', onExit);
  child.once('error', onError);

  function terminate(): void {
    if (settled || terminationStarted) return;
    terminationStarted = true;
    void runSignal('SIGTERM').then(() => {
      if (settled || killSent) return;
      killTimer = setTimeout(forceKill, options.killGraceMs);
    });
  }

  function forceKill(): void {
    if (settled || killSent) return;
    terminationStarted = true;
    killSent = true;
    if (killTimer) clearTimeout(killTimer);
    void runSignal('SIGKILL').then(() => {
      if (settled || rootExited) return;
      exitAcknowledgementTimer = setTimeout(() => {
        if (settled || rootExited) return;
        void runSignal('SIGKILL').then(() => {
          if (settled || rootExited) return;
          outputDrain.dispose();
          fail(new Error('Child process did not acknowledge exit after forced termination'));
        });
      }, options.exitAcknowledgementMs ?? DEFAULT_PROCESS_TERMINATION_GRACE_MS);
    });
  }

  function runSignal(treeSignal: 'SIGTERM' | 'SIGKILL'): Promise<boolean> {
    signalsInFlight += 1;
    return signalTree(treeSignal).finally(() => {
      signalsInFlight -= 1;
      maybeFinish();
    });
  }

  function signalTree(treeSignal: 'SIGTERM' | 'SIGKILL'): Promise<boolean> {
    try {
      return (
        options.signalProcessTree?.(treeSignal) ?? terminateChildProcessTree(child, treeSignal)
      ).catch(() => false);
    } catch {
      return Promise.resolve(false);
    }
  }

  function maybeFinish(): void {
    if (!rootExited || !outputDrainResult || signalsInFlight > 0) return;
    finish();
  }

  function finish(): void {
    if (settled) return;
    settled = true;
    cleanup();
    resolveCompletion({
      exitCode,
      signal,
      ioDrained: !ioDrainTimedOut,
      incompleteOutputs: new Set(outputDrainResult?.incomplete),
    });
  }

  function fail(error: Error): void {
    if (settled) return;
    settled = true;
    cleanup();
    rejectCompletion(error);
  }

  function cleanup(): void {
    if (killTimer) clearTimeout(killTimer);
    if (exitAcknowledgementTimer) clearTimeout(exitAcknowledgementTimer);
    outputDrain.dispose();
    child.off('exit', onExit);
    child.off('error', onError);
  }

  maybeFinish();
  return { completion, terminate, forceKill };
}
