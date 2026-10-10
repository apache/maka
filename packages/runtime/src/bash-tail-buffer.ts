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
// `cap` characters. Trimming avoids splitting a UTF-16 surrogate pair.

export class BashTailBuffer {
  private chunks: string[] = [];
  private retained = 0;

  constructor(private readonly cap: number) {}

  push(chunk: string): void {
    if (!chunk) return;
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
    let start = Math.max(0, joined.length - this.cap);
    if (
      start > 0 &&
      isLowSurrogate(joined.charCodeAt(start)) &&
      isHighSurrogate(joined.charCodeAt(start - 1))
    ) {
      start += 1;
    }
    const kept = joined.slice(start);
    this.chunks = kept ? [kept] : [];
    this.retained = kept.length;
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
