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

export interface BoundedChunkBufferOptions<T> {
  maxChars: number;
  maxChunks: number;
  textOf: (chunk: T) => string;
  withText: (chunk: T, text: string) => T;
  sequence?: (chunk: T) => number;
}

/** A tail buffer bounded by both retained text and retained chunk objects. */
export class BoundedChunkBuffer<T> {
  private chunks: Array<T | undefined> = [];
  private head = 0;
  private retainedChars = 0;
  private cachedValues: readonly T[] | undefined;
  private discardedThroughSequence: number | undefined;
  private dropped = 0;
  private revision = 0;

  constructor(private readonly options: BoundedChunkBufferOptions<T>) {}

  get length(): number {
    return this.chunks.length - this.head;
  }

  get droppedChars(): number {
    return this.dropped;
  }

  get version(): number {
    return this.revision;
  }

  values(): readonly T[] {
    this.cachedValues ??= this.chunks.slice(this.head) as T[];
    return this.cachedValues;
  }

  append(chunk: T): boolean {
    const sequenceOf = this.options.sequence;
    if (sequenceOf) {
      const sequence = sequenceOf(chunk);
      if (
        this.discardedThroughSequence !== undefined &&
        sequence <= this.discardedThroughSequence
      ) {
        return false;
      }
      for (let index = this.head; index < this.chunks.length; index += 1) {
        const candidate = this.chunks[index];
        if (candidate !== undefined && sequenceOf(candidate) === sequence) return false;
      }
    }

    this.insert(chunk);
    this.retainedChars += this.options.textOf(chunk).length;
    this.trim();
    this.revision += 1;
    this.cachedValues = undefined;
    return true;
  }

  private insert(chunk: T): void {
    const sequenceOf = this.options.sequence;
    const last = this.chunks[this.chunks.length - 1];
    if (!sequenceOf || last === undefined || sequenceOf(last) <= sequenceOf(chunk)) {
      this.chunks.push(chunk);
      return;
    }

    this.compactStorage(true);
    const index = this.chunks.findIndex(
      (candidate) => candidate !== undefined && sequenceOf(candidate) > sequenceOf(chunk),
    );
    this.chunks.splice(index < 0 ? this.chunks.length : index, 0, chunk);
  }

  private trim(): void {
    let excess = this.retainedChars - this.options.maxChars;
    while (excess > 0 && this.length > 0) {
      const first = this.chunks[this.head];
      if (first === undefined) break;
      const text = this.options.textOf(first);
      if (text.length <= excess) {
        this.dropFirst(first, text.length);
        excess -= text.length;
        continue;
      }
      const cut = unicodeSafePrefixLength(text, excess);
      this.chunks[this.head] = this.options.withText(first, text.slice(cut));
      this.retainedChars -= cut;
      this.dropped += cut;
      excess = 0;
    }
    while (this.length > this.options.maxChunks) {
      const first = this.chunks[this.head];
      if (first === undefined) break;
      this.dropFirst(first, this.options.textOf(first).length);
    }
    this.compactStorage(false);
  }

  private dropFirst(chunk: T, chars: number): void {
    const sequence = this.options.sequence?.(chunk);
    if (
      sequence !== undefined &&
      (this.discardedThroughSequence === undefined || this.discardedThroughSequence < sequence)
    ) {
      this.discardedThroughSequence = sequence;
    }
    this.chunks[this.head] = undefined;
    this.head += 1;
    this.retainedChars -= chars;
    this.dropped += chars;
  }

  private compactStorage(force: boolean): void {
    if (this.head === 0) return;
    if (!force && (this.head < 64 || this.head * 2 < this.chunks.length)) return;
    this.chunks.splice(0, this.head);
    this.head = 0;
  }
}

function unicodeSafePrefixLength(text: string, minimum: number): number {
  const before = text.charCodeAt(minimum - 1);
  const after = text.charCodeAt(minimum);
  const splitsSurrogatePair =
    before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
  return splitsSurrogatePair ? minimum + 1 : minimum;
}
