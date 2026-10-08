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

import type { DatabaseSync } from 'node:sqlite';

/**
 * Recall folds text as NFC + Unicode lowercase; SQLite's `lower()` folds ASCII
 * only. A candidate scan therefore matches `lower(stored)` and, for every
 * record where the two folds disagree, offers the record unconditionally. This
 * module is that disagreement test, registered on a connection so a scan
 * stays one SQL statement, plus the guard that keeps a raw term out of it.
 *
 * A record is stable when Unicode folding changes nothing ASCII folding would
 * not: no cased letters outside ASCII, no compatibility or decomposed forms
 * that NFC rewrites. On stable records `instr(lower(stored), term)` is exactly
 * recall's predicate, and on unstable ones the record is a candidate anyway,
 * so the scan never under-selects whatever script the transcript is in.
 */
export const RECALL_FOLD_UNSTABLE_FUNCTION = 'maka_recall_fold_unstable';

const ASCII_ONLY_PATTERN = /^[\u0000-\u007f]*$/u;
const ASCII_UPPERCASE_PATTERN = /[A-Z]/gu;

export function isRecallFoldUnstable(value: string): boolean {
  if (ASCII_ONLY_PATTERN.test(value)) return false;
  return (
    value.normalize('NFC').toLowerCase() !==
    value.replace(ASCII_UPPERCASE_PATTERN, (character) => character.toLowerCase())
  );
}

export function registerRecallFoldFunction(db: DatabaseSync): void {
  db.function(RECALL_FOLD_UNSTABLE_FUNCTION, { deterministic: true, directOnly: true }, (value) =>
    typeof value === 'string' && isRecallFoldUnstable(value) ? 1 : 0,
  );
}

/**
 * A raw term against a folded record would under-select silently, which is the
 * one failure a candidate scan exists to rule out. Fail loudly instead.
 */
export function assertFoldedSearchTerm(term: string): void {
  if (term !== term.normalize('NFC').toLowerCase()) {
    throw new Error('Recall candidate terms must be folded');
  }
}

/**
 * The OR-combined match clause for one text column: a folded term inside the
 * ASCII-lowered value, or a value whose fold SQLite cannot reproduce. Binds one
 * parameter per term, in order.
 */
export function recallFoldedMatchClause(column: string, termCount: number): string {
  const matches: string[] = [];
  for (let index = 0; index < termCount; index += 1) {
    matches.push(`instr(lower(${column}), ?) > 0`);
  }
  matches.push(`${RECALL_FOLD_UNSTABLE_FUNCTION}(${column})`);
  return matches.join(' OR ');
}
