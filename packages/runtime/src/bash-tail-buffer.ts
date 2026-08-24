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

// packages/runtime/src/bash-tail-buffer.ts
//
// Memory-bounded tail accumulator for streaming shell output. A runaway command
// must not be able to grow the captured result without limit (the old Bash path
// instead discarded ALL output past a hard cap), so we retain only the last
// `cap` characters.
//
// SECURITY: the retained tail is later passed through redactSecrets before it
// reaches the model / UI. redactSecrets matches on full tokens and their
// prefixes (e.g. `Authorization: Bearer …`, `sk-…`), so a tail that begins in
// the MIDDLE of a secret-bearing line would defeat redaction and leak the
// suffix. To prevent that, when the buffer actually drops content it also drops
// the (partial) leading line, so the retained tail always starts at a line
// boundary and redaction sees whole lines.

export class BashTailBuffer {
  private chunks: string[] = [];
  private retained = 0;
  // True when we dropped an unterminated oversized line: subsequent chunks are
  // still part of that compromised line and must be discarded until the next
  // newline, otherwise a continuation chunk (a secret's severed suffix) would
  // be retained as if it were a clean line and defeat downstream redaction.
  private insideDroppedLine = false;
  // Latches true once we drop an oversized no-newline line entirely (the case
  // above). Callers surface a marker so a result that looks empty is not
  // mistaken for "the command produced nothing" — content existed but could not
  // be safely truncated.
  private droppedUnsafe = false;

  constructor(private readonly cap: number) {}

  /** Whether an oversized, unsafe-to-truncate line was dropped from the tail. */
  hasDroppedUnsafe(): boolean {
    return this.droppedUnsafe;
  }

  push(chunk: string): void {
    if (!chunk) return;
    if (this.insideDroppedLine) {
      const nl = chunk.indexOf('\n');
      if (nl < 0) return; // whole chunk is still the dropped line — discard it
      this.insideDroppedLine = false;
      chunk = chunk.slice(nl + 1); // resume from the first clean line boundary
      if (!chunk) return;
    }
    this.chunks.push(chunk);
    this.retained += chunk.length;
    // Amortize: allow growth to 2x cap before compacting back to cap so appends
    // stay ~O(1) rather than re-slicing the whole buffer on every chunk.
    if (this.retained > this.cap * 2) this.trim();
  }

  value(): string {
    this.trim();
    return this.chunks[0] ?? '';
  }

  private trim(): void {
    if (this.chunks.length <= 1 && this.retained <= this.cap) return;
    const joined = this.chunks.join('');
    let kept = joined.length > this.cap ? joined.slice(joined.length - this.cap) : joined;
    if (kept.length < joined.length) {
      // We sliced mid-stream. Drop the partial leading line so the retained tail
      // starts at a line boundary and downstream redaction never sees a secret
      // whose prefix was cut off (see SECURITY note above). With no newline the
      // whole tail is one partial line we cannot make safe — drop it entirely
      // rather than risk leaking a severed secret. (A single line larger than
      // the cap is pathological; the common single-line case is <= cap and is
      // never sliced here.)
      const nl = kept.indexOf('\n');
      if (nl >= 0) {
        kept = kept.slice(nl + 1);
      } else {
        // No line boundary in the retained tail: drop it and stay "inside" the
        // dropped line so its continuation chunks are discarded until a newline.
        kept = '';
        this.insideDroppedLine = true;
        this.droppedUnsafe = true;
      }
    }
    this.chunks = kept ? [kept] : [];
    this.retained = kept.length;
  }
}
