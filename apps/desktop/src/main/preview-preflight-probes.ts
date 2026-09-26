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

/**
 * The OS-touching half of the local preview preflight: the probes that decide
 * a capability's status by actually trying something. Classification lives in
 * preview-preflight.ts and never imports this file, so the statuses stay
 * testable without a socket.
 *
 * A probe reports a connection outcome as a value, never as a throw, so the
 * classifier — not an exception handler — decides what the outcome proves.
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { browserAutomationAvailable, browserViewHost } from './browser/browser-host.js';
import type { LoopbackProbe, PreviewPreflightAuthority } from './preview-preflight.js';

/**
 * A preview endpoint on loopback either answers immediately or is not up yet;
 * a long wait here would only turn a fast, honest `unknown` into a slow one.
 */
export const LOOPBACK_PROBE_TIMEOUT_MS = 2_000;

export interface PreviewPreflightProbeDeps {
  /** Overrides the loopback deadline so a test can reach it without a real wait. */
  readonly loopbackTimeoutMs?: number;
}

export function createPreviewPreflightAuthority(
  deps: PreviewPreflightProbeDeps = {},
): PreviewPreflightAuthority {
  const loopbackTimeoutMs = deps.loopbackTimeoutMs ?? LOOPBACK_PROBE_TIMEOUT_MS;
  return {
    guiSurfaceAvailable: () => browserAutomationAvailable(),
    browserDrivable: ({ sessionId, signal }) => {
      signal.throwIfAborted();
      return browserViewHost().canDrive(sessionId, 'observe', { signal });
    },
    probeLoopback: ({ origin, signal }) => probeLoopback(origin, signal, loopbackTimeoutMs),
  };
}

/**
 * `HEAD /` against the origin, settled by the first of: a response, an
 * upgrade, an error, the caller's abort, or the deadline.
 *
 * HEAD to the root, never the caller's path: a dev server may attach side
 * effects to a route, and a capability check must not trip them.
 *
 * The deadline lives here rather than on the socket. A server answering
 * `101 Switching Protocols` makes Node route the exchange to `upgrade` and
 * close the request without emitting `response` or `error`, taking any
 * socket-bound timeout with it. The deadline is therefore the one catch-all:
 * whatever else does or does not fire, the probe settles within it.
 */
function probeLoopback(
  origin: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<LoopbackProbe> {
  signal.throwIfAborted();
  const url = new URL('/', origin);
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<LoopbackProbe>((resolve, reject) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;

    function finish(settle: () => void): void {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      signal.removeEventListener('abort', abandon);
      // Marked settled first, so the teardown's own error cannot re-enter.
      probe.destroy();
      settle();
    }
    function answer(result: LoopbackProbe): void {
      finish(() => resolve(result));
    }
    // An aborted turn is a cancellation, not a statement about the endpoint.
    function abandon(): void {
      finish(() => reject(signal.reason));
    }

    const probe = send(url, { method: 'HEAD' }, (response) => {
      response.resume();
      answer({ kind: 'answered', status: response.statusCode ?? 0 });
    });
    probe.on('upgrade', (response, socket) => {
      // The upgraded socket is detached from the request, so destroying the
      // request would leave it open. A 101 is still an answer: something
      // listened at that address, which is all this capability claims.
      socket.destroy();
      answer({ kind: 'answered', status: response.statusCode ?? 0 });
    });
    probe.on('error', (error) => {
      if (signal.aborted) abandon();
      else answer({ kind: 'no_answer', cause: describeCause(error) });
    });
    deadline = setTimeout(
      () => answer({ kind: 'no_answer', cause: `no response within ${timeoutMs}ms` }),
      timeoutMs,
    );
    signal.addEventListener('abort', abandon, { once: true });
    probe.end();
  });
}

/** Prefer the errno: ECONNREFUSED says more to a caller than its sentence does. */
function describeCause(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === 'string' && code !== '') return code;
  }
  return error instanceof Error ? error.message : String(error);
}
