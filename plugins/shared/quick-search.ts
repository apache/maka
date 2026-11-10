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

function score(term: string, needle: string): number | null {
  const text = term.toLowerCase();
  if (text === needle) return 0;
  if (text.startsWith(needle)) return 1;
  if (text.includes(` ${needle}`)) return 2;
  return needle.length >= 2 && text.includes(needle) ? 3 : null;
}

/** The best matches for `query`, best first; a blank query matches nothing. */
export function rank<T>(
  items: readonly T[],
  query: string,
  terms: (item: T) => readonly string[],
  limit: number,
): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];
  const matched: { item: T; score: number }[] = [];
  for (const item of items) {
    const scores = terms(item)
      .map((term) => score(term, needle))
      .filter((value) => value !== null);
    if (scores.length > 0) matched.push({ item, score: Math.min(...scores) });
  }
  return matched
    .sort((left, right) => left.score - right.score)
    .slice(0, limit)
    .map((match) => match.item);
}

/** The text after a leading keyword, or null when `query` does not start with one. */
export function afterKeyword(query: string, keywords: readonly string[]): string | null {
  const text = query.trimStart();
  const lower = text.toLowerCase();
  for (const keyword of keywords) {
    const word = keyword.toLowerCase();
    if (lower === word) return '';
    if (lower.startsWith(`${word} `)) return text.slice(word.length + 1).trim();
  }
  return null;
}
