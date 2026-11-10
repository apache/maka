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

/** How well the best of `terms` matches, lower being better; null when none does. */
export function matchOf(terms: readonly string[], query: string): number | null {
  const needle = query.trim().toLowerCase();
  if (needle === '') return null;
  const scores = terms.map((term) => score(term, needle)).filter((value) => value !== null);
  return scores.length > 0 ? Math.min(...scores) : null;
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

export type Found<T> = { item: T; match: number };

/**
 * What a tool offers for `query`. A blank query or a bare keyword offers everything; text after
 * a keyword is searched, and other text only when the tool is `searchedDirectly`.
 */
export function search<T>(
  items: readonly T[],
  query: string,
  keywords: readonly string[],
  terms: (item: T) => readonly string[],
  searchedDirectly = false,
): Found<T>[] {
  const text = query.trim() === '' ? '' : afterKeyword(query, keywords);
  if (text === '') return items.map((item) => ({ item, match: 0 }));
  if (text === null && !searchedDirectly) return [];
  return items.flatMap((item) => {
    const match = matchOf(terms(item), text ?? query);
    return match === null ? [] : [{ item, match }];
  });
}
