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

/** Keep xterm's asynchronous parser queue to one write. Congestion is repaired
 * from a terminal snapshot, never by buffering an unbounded renderer backlog. */
export class SessionTerminalRenderQueue {
  #pending: { data: string; reset: boolean }[] = [];
  #bytes = 0;
  #writing = false;
  #overflow = false;
  #closed = false;

  constructor(private readonly sink: {
    write(data: string, done: () => void): void;
    reset(): void;
    resync(): void;
  }) {}

  append(data: string): void {
    if (this.#closed || this.#overflow) return;
    if (this.#pending.length >= 32 || this.#bytes + data.length * 2 > 256 * 1024) {
      this.#pending = [];
      this.#bytes = 0;
      this.#overflow = true;
      if (!this.#writing) this.sink.resync();
      return;
    }
    this.#pending.push({ data, reset: false });
    this.#bytes += data.length * 2;
    this.#pump();
  }

  replace(snapshot: string): void {
    if (this.#closed) return;
    // The snapshot itself is bounded by the Host PTY snapshot contract.
    this.#pending = [{ data: snapshot, reset: true }];
    this.#bytes = snapshot.length * 2;
    this.#overflow = false;
    this.#pump();
  }

  close(): void {
    this.#closed = true;
    this.#pending = [];
    this.#bytes = 0;
  }

  #pump(): void {
    if (this.#closed || this.#writing || this.#overflow) return;
    const entry = this.#pending.shift();
    if (!entry) return;
    this.#bytes -= entry.data.length * 2;
    this.#writing = true;
    if (entry.reset) this.sink.reset();
    this.sink.write(entry.data, () => {
      this.#writing = false;
      if (this.#closed) return;
      if (this.#overflow) this.sink.resync();
      else this.#pump();
    });
  }
}

export class SessionTerminalHydration {
  readonly #pending: TerminalDataChunk[] = [];
  #epoch = 0;
  #attached = false;
  #lastSequence = 0;
  #pendingBytes = 0;
  #needsSnapshot = false;

  get needsSnapshot(): boolean {
    return this.#needsSnapshot;
  }

  begin(): number {
    this.#epoch += 1;
    this.#attached = false;
    this.#pending.length = 0;
    this.#pendingBytes = 0;
    this.#lastSequence = 0;
    this.#needsSnapshot = false;
    return this.#epoch;
  }

  isCurrent(epoch: number): boolean {
    return epoch === this.#epoch;
  }

  accept(event: TerminalDataChunk): TerminalDataChunk | undefined {
    if (this.#needsSnapshot) return undefined;
    if (event.sequence <= this.#lastSequence) return undefined;
    if (!this.#attached) {
      if (this.#pending.length >= 128 || this.#pendingBytes + event.data.length * 2 > 256 * 1024) {
        this.#invalidate();
        return undefined;
      }
      this.#pending.push(event);
      this.#pendingBytes += event.data.length * 2;
      return undefined;
    }
    if (event.sequence !== this.#lastSequence + 1) {
      this.#invalidate();
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
    if (this.#needsSnapshot) return undefined;
    this.#lastSequence = snapshot.sequence;
    this.#attached = true;
    const replay: TerminalDataChunk[] = [];
    for (const event of this.#pending.sort((left, right) => left.sequence - right.sequence)) {
      if (event.sequence <= this.#lastSequence) continue;
      if (event.sequence !== this.#lastSequence + 1) {
        this.#invalidate();
        return undefined;
      }
      this.#lastSequence = event.sequence;
      replay.push(event);
    }
    this.#pending.length = 0;
    this.#pendingBytes = 0;
    return { snapshot, replay };
  }

  #invalidate(): void {
    this.#needsSnapshot = true;
    this.#attached = false;
    this.#pending.length = 0;
    this.#pendingBytes = 0;
  }
}
