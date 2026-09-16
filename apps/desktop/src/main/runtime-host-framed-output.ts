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

export function createRuntimeHostFramedOutputFilter<Frame>(input: {
  readonly prefix: string;
  readonly pendingMaxBytes: number;
  readonly decode: (line: string) => Frame | undefined;
  readonly label: string;
  readonly onFrame: (frame: Frame) => void;
  readonly onError: (error: Error) => void;
}): { push(data: string): string; finish(): string } {
  let pending = '';
  let discardReservedLine = false;
  const drain = (finished: boolean): string => {
    let visible = '';
    while (pending) {
      if (discardReservedLine) {
        const newline = pending.indexOf('\n');
        if (newline < 0) {
          pending = '';
          break;
        }
        pending = pending.slice(newline + 1);
        discardReservedLine = false;
        continue;
      }
      const marker = pending.indexOf(input.prefix);
      if (marker >= 0) {
        visible += pending.slice(0, marker);
        pending = pending.slice(marker);
        const newline = pending.indexOf('\n');
        if (newline < 0) {
          if (finished) {
            input.onError(new Error(`${input.label} returned an incomplete result`));
            pending = '';
          } else if (pending.length > input.pendingMaxBytes) {
            input.onError(new Error(`${input.label} returned an oversized result`));
            pending = '';
            discardReservedLine = true;
          }
          break;
        }
        const line = pending.slice(0, newline + 1);
        pending = pending.slice(newline + 1);
        const frame = input.decode(line);
        if (frame) input.onFrame(frame);
        else input.onError(new Error(`${input.label} returned an invalid result`));
        continue;
      }
      if (finished) {
        visible += pending;
        pending = '';
        break;
      }
      const retained = markerSuffixLength(pending, input.prefix);
      visible += pending.slice(0, pending.length - retained);
      pending = pending.slice(pending.length - retained);
      break;
    }
    return visible;
  };
  return {
    push(data) {
      pending += data;
      return drain(false);
    },
    finish() {
      return drain(true);
    },
  };
}

function markerSuffixLength(value: string, prefix: string): number {
  const limit = Math.min(value.length, prefix.length - 1);
  for (let length = limit; length > 0; length -= 1) {
    if (prefix.startsWith(value.slice(-length))) return length;
  }
  return 0;
}
