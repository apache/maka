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

import type { Event, RenderProcessGoneDetails } from 'electron';

interface RenderProcessGoneSource {
  once(
    event: 'render-process-gone',
    listener: (event: unknown, details: RenderProcessGoneDetails) => void,
  ): void;
}

interface MainRendererReloadSource {
  once(event: 'unresponsive', listener: () => void): void;
  once(
    event: 'render-process-gone',
    listener: (event: Event, details: RenderProcessGoneDetails) => void,
  ): void;
  once(event: 'destroyed', listener: () => void): void;
  on(
    event: 'did-fail-load',
    listener: (
      event: Event,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean,
      frameProcessId: number,
      frameRoutingId: number,
    ) => void,
  ): void;
  off(event: 'unresponsive', listener: () => void): void;
  off(
    event: 'render-process-gone',
    listener: (event: Event, details: RenderProcessGoneDetails) => void,
  ): void;
  off(event: 'destroyed', listener: () => void): void;
  off(
    event: 'did-fail-load',
    listener: (
      event: Event,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean,
      frameProcessId: number,
      frameRoutingId: number,
    ) => void,
  ): void;
  isDestroyed(): boolean;
  reload(): void;
}

export interface MainRendererFrameIdentity {
  readonly processId: number;
  readonly frameToken: string;
}

export function observeMainRendererProcessGone(deps: {
  readonly source: RenderProcessGoneSource;
  readonly shutdownSignal: AbortSignal;
  readonly onUnexpectedExit: (details: RenderProcessGoneDetails) => void;
}): void {
  deps.source.once('render-process-gone', (_event, details) => {
    if (deps.shutdownSignal.aborted || details.reason === 'clean-exit') return;
    deps.onUnexpectedExit(details);
  });
}

/**
 * Waits for a crashed main Renderer to report its first committed paint before
 * recovery is successful. The ordinary one-shot crash observer is re-armed
 * synchronously by `onReady`, leaving no successful-recovery gap unobserved.
 */
export function reloadMainRendererProcess(deps: {
  readonly source: MainRendererReloadSource;
  readonly shutdownSignal: AbortSignal;
  readonly subscribeMainFrameCommitted: (
    listener: (frame: MainRendererFrameIdentity) => void,
  ) => () => void;
  readonly subscribeRendererReady: (
    listener: (frame: MainRendererFrameIdentity) => boolean,
  ) => () => void;
  readonly onReady: () => void;
  readonly timeoutMs?: number;
}): Promise<boolean> {
  if (deps.shutdownSignal.aborted || deps.source.isDestroyed()) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let committedFrame: MainRendererFrameIdentity | undefined;
    let unsubscribeMainFrameCommitted = (): void => {};
    let unsubscribeRendererReady = (): void => {};
    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      unsubscribeMainFrameCommitted();
      unsubscribeRendererReady();
      deps.source.off('did-fail-load', onFailed);
      deps.source.off('unresponsive', onUnresponsive);
      deps.source.off('render-process-gone', onGone);
      deps.source.off('destroyed', onDestroyed);
      deps.shutdownSignal.removeEventListener('abort', onAborted);
    };
    const settle = (loaded: boolean): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(loaded);
    };
    const onRendererReady = (frame: MainRendererFrameIdentity): boolean => {
      if (!sameFrame(frame, committedFrame)) return false;
      try {
        deps.onReady();
        settle(true);
        return true;
      } catch {
        settle(false);
        return false;
      }
    };
    const onFailed = (
      _event: Event,
      _errorCode: number,
      _errorDescription: string,
      _validatedURL: string,
      isMainFrame: boolean,
    ): void => {
      if (isMainFrame) settle(false);
    };
    const onUnresponsive = (): void => settle(false);
    const onGone = (_event: Event, _details: RenderProcessGoneDetails): void => settle(false);
    const onDestroyed = (): void => settle(false);
    const onAborted = (): void => settle(false);

    unsubscribeMainFrameCommitted = deps.subscribeMainFrameCommitted((frame) => {
      committedFrame = frame;
    });
    unsubscribeRendererReady = deps.subscribeRendererReady(onRendererReady);
    deps.source.on('did-fail-load', onFailed);
    deps.source.once('unresponsive', onUnresponsive);
    deps.source.once('render-process-gone', onGone);
    deps.source.once('destroyed', onDestroyed);
    deps.shutdownSignal.addEventListener('abort', onAborted, { once: true });
    timeout = setTimeout(() => settle(false), deps.timeoutMs ?? 30_000);
    try {
      deps.source.reload();
    } catch {
      settle(false);
    }
  });
}

function sameFrame(
  actual: MainRendererFrameIdentity,
  expected: MainRendererFrameIdentity | undefined,
): boolean {
  if (!expected) return false;
  return (
    actual.processId === expected.processId &&
    actual.frameToken === expected.frameToken
  );
}
