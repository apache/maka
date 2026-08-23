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

// Transport pieces shared by every stdio JSON-RPC executor the host supervises:
// trycua/cua-driver (MCP) and maka-cu (maka.cu/1). Both frame one JSON value per
// line over a direct child's stdio, so the decoder and the lifecycle vocabulary
// live here.
//
// What is deliberately NOT shared is the supervision policy above the framing:
// cua-driver kills the child to cancel a delivered request, maka-cu sends
// `$/cancel` and waits for the executor's own answer (maka.cu/1 §7.2), and the
// two handshakes and shutdown sequences have nothing in common. A single
// supervisor would carry a flag per divergence, which is how the behaviour that
// only one of the two executors needs ends up running against both.

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
  if (rest.length > handlers.maxBufferBytes) {
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
