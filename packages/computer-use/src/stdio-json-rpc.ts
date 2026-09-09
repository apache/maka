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

// Framing and lifecycle vocabulary for the one supervised child every
// `maka.cu/2` platform executor uses. One JSON value is framed per line over a
// direct child's stdio, the unparsed tail is bounded by a negotiated byte
// budget, and the host classifies where a request was when the child died.
//
// There is deliberately only one supervisor (`MakaCuService`); a platform
// backend adds a native executor and composition, never a second framing or
// lifecycle authority. cua-driver, the previous second executor with its own
// MCP-mode decoder and kill-to-cancel policy, was removed along with the role
// pair it belonged to.

/** Where a request was when the child died — the input to death classification. */
export type HostRequestStage = 'queued' | 'writing' | 'delivered' | 'settled';

export type HostLifecycleErrorCode =
  | 'outcome_unknown'
  | 'service_unavailable'
  | 'service_mismatch'
  | 'aborted';

export function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    signal.addEventListener('abort', () => reject(new Error('aborted')), {
      once: true,
    });
  });
}

export interface JsonLineDecoderHandlers {
  /** Cap on the unparsed tail. Exceeding it means the peer stopped framing. */
  maxBufferBytes: number;
  /** Called instead of parsing when the cap is exceeded; the caller tears down. */
  onOverflow: () => void;
  onMessage: (message: unknown) => void;
  /**
   * A line that is not JSON. maka.cu/1 §1 makes this a protocol violation the
   * host counts; cua-driver's MCP mode never promised a clean stdout, so it
   * passes no handler and the line is dropped.
   */
  onNonJsonLine?: (line: string) => void;
}

/** Decode as many whole lines as `chunk` completes; returns the unparsed tail. */
export function decodeJsonLines(
  buffer: string,
  chunk: string,
  handlers: JsonLineDecoderHandlers,
): string {
  let rest = buffer + chunk;
  if (Buffer.byteLength(rest, 'utf8') > handlers.maxBufferBytes) {
    handlers.onOverflow();
    return rest;
  }
  let index: number;
  while ((index = rest.indexOf('\n')) >= 0) {
    const line = rest.slice(0, index).trim();
    rest = rest.slice(index + 1);
    if (!line) continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      handlers.onNonJsonLine?.(line);
      continue;
    }
    handlers.onMessage(message);
  }
  return rest;
}
