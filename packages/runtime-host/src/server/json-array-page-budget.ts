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
 * Budgets a page of plain protocol projections without encoding its accepted
 * items again. The template must contain the empty item array and a null cursor
 * (or nextOffset); all other fields must stay unchanged while assembling a page.
 * Accepted items must also remain unchanged. This counts a result, not a frame.
 */
export class JsonArrayPageBudget {
  readonly #envelopeBytes: number;
  #itemsBytes = 0;
  #count = 0;

  constructor(
    private readonly maxBytes: number,
    emptyPage: object,
  ) {
    // The template already includes array brackets and the cursor's field name.
    this.#envelopeBytes = jsonBytes(emptyPage) - 'null'.length;
  }

  tryAppend(item: unknown, cursor: unknown): boolean {
    // JSON array elements that encode as undefined are represented by null.
    const itemBytes = Buffer.byteLength(JSON.stringify(item) ?? 'null', 'utf8');
    const candidateBytes = this.#itemsBytes + (this.#count > 0 ? 1 : 0) + itemBytes;
    if (this.#envelopeBytes + candidateBytes + jsonBytes(cursor) > this.maxBytes) return false;
    this.#itemsBytes = candidateBytes;
    this.#count += 1;
    return true;
  }
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
