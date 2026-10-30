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

/** Local lexical retrieval supplies possible context, never a relevance/action decision. */
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
export function contextTerms(text: string): string[] {
  return [
    ...new Set(
      [...segmenter.segment(text.toLocaleLowerCase())]
        .filter((s) => s.isWordLike && s.segment.length > 1 && s.segment.length <= 64)
        .map((s) => s.segment),
    ),
  ];
}
export function relatedContext<T extends { text: string }>(
  queries: string[],
  documents: T[],
  limit = 12,
  maxChars = 12000,
): T[] {
  const terms = new Set(contextTerms(queries.join('\n')));
  if (!terms.size) return [];
  const candidates = documents.map((item, i) => ({
    item,
    i,
    words: new Set(contextTerms(item.text)),
  }));
  const counts = new Map<string, number>();
  for (const c of candidates)
    for (const term of c.words) if (terms.has(term)) counts.set(term, (counts.get(term) ?? 0) + 1);
  const ranked = candidates
    .map((c) => ({
      ...c,
      score: [...c.words].reduce(
        (n, t) => n + (terms.has(t) ? Math.log(1 + documents.length / (counts.get(t) ?? 1)) : 0),
        0,
      ),
    }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || b.i - a.i);
  const result: T[] = [];
  let chars = 0;
  for (const c of ranked) {
    if (result.length >= limit) break;
    const text = c.item.text.slice(0, Math.min(4000, maxChars - chars));
    if (!text) break;
    result.push({ ...c.item, text });
    chars += text.length;
  }
  return result;
}
