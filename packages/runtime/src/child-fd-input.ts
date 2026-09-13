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
import { closeSync } from 'node:fs';
import type { Writable } from 'node:stream';

export type ChildFdInput =
  | { fd: number; data: Uint8Array }
  | { fd: number; sourceFd: number; releaseSource?: () => void };

export function buildSpawnStdio(
  fdInputs: readonly ChildFdInput[] | undefined,
  stdin: 'ignore' | 'pipe' = 'ignore',
): Array<'ignore' | 'pipe' | number> {
  const stdio: Array<'ignore' | 'pipe' | number> = [stdin, 'pipe', 'pipe'];
  for (const input of fdInputs ?? []) {
    if (!Number.isInteger(input.fd) || input.fd < 3 || input.fd > 64) {
      throw new Error(
        `Child fd input must use an integer fd between 3 and 64; received ${input.fd}`,
      );
    }
    if ('sourceFd' in input && (!Number.isInteger(input.sourceFd) || input.sourceFd < 0)) {
      throw new Error(
        `Child fd input source must be a non-negative integer; received ${input.sourceFd}`,
      );
    }
    while (stdio.length <= input.fd) stdio.push('ignore');
    if (stdio[input.fd] !== 'ignore') throw new Error(`Duplicate child fd input ${input.fd}`);
    stdio[input.fd] = 'data' in input ? 'pipe' : input.sourceFd;
  }
  return stdio;
}

export function writeChildFdInputs(
  child: ChildProcess,
  fdInputs: readonly ChildFdInput[] | undefined,
): void {
  for (const input of fdInputs ?? []) {
    if (!('data' in input)) continue;
    const stream = child.stdio[input.fd] as Writable | null | undefined;
    if (!stream || typeof stream.end !== 'function') {
      throw new Error(`Child fd ${input.fd} was not opened as a writable pipe`);
    }
    // A helper can exit before consuming the whole payload. Treat EPIPE as a
    // child execution failure, not an unhandled host-process stream error.
    stream.on('error', () => {});
    stream.end(Buffer.from(input.data));
  }
}

/** Close host descriptors after spawn has duplicated them into the child. */
export function closeChildFdSources(fdInputs: readonly ChildFdInput[] | undefined): void {
  const closed = new Set<number>();
  for (const input of fdInputs ?? []) {
    if (!('sourceFd' in input) || closed.has(input.sourceFd)) continue;
    closed.add(input.sourceFd);
    try {
      if (input.releaseSource) input.releaseSource();
      else closeSync(input.sourceFd);
    } catch {
      // The source owner is close-once when supplied; launch cleanup is best effort.
    }
  }
}
