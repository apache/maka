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

export interface TerminalDataChunk {
  readonly sequence: number;
  readonly data: string;
}

export interface TerminalSnapshot {
  readonly sequence: number;
  readonly buffer: string;
}

export class SessionTerminalHydration {
  readonly #pending: TerminalDataChunk[] = [];
  #epoch = 0;
  #attached = false;
  #lastSequence = 0;

  begin(): number {
    this.#epoch += 1;
    this.#attached = false;
    this.#pending.length = 0;
    return this.#epoch;
  }

  isCurrent(epoch: number): boolean {
    return epoch === this.#epoch;
  }

  accept(event: TerminalDataChunk): TerminalDataChunk | undefined {
    if (event.sequence <= this.#lastSequence) return undefined;
    if (!this.#attached) {
      this.#pending.push(event);
      return undefined;
    }
    this.#lastSequence = event.sequence;
    return event;
  }

  commit(
    epoch: number,
    snapshot: TerminalSnapshot,
  ): { snapshot: TerminalSnapshot; replay: TerminalDataChunk[] } | undefined {
    if (!this.isCurrent(epoch)) return undefined;
    this.#lastSequence = snapshot.sequence;
    this.#attached = true;
    const replay: TerminalDataChunk[] = [];
    for (const event of this.#pending.sort((left, right) => left.sequence - right.sequence)) {
      if (event.sequence <= this.#lastSequence) continue;
      this.#lastSequence = event.sequence;
      replay.push(event);
    }
    this.#pending.length = 0;
    return { snapshot, replay };
  }
}
