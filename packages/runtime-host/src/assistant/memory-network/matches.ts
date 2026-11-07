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

/** Literal search over the exact text used by MemoryOriginal offsets. No model or rewriting. */
export function originalMatches(text: string, terms: string[], from = 0, contextChars = 240) {
  const escaped = [...new Set(terms.filter((s) => s.trim()))]
    .sort((a, b) => b.length - a.length)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!escaped.length) throw Error('find requires a nonempty literal search term');
  if (from > text.length) throw Error('offsetChars exceeds original length');
  const regex = new RegExp(escaped.join('|'), 'giu');
  const hits: { start: number; end: number }[] = [];
  for (const match of text.matchAll(regex)) {
    if (match.index >= from) hits.push({ start: match.index, end: match.index + match[0].length });
  }
  const snippet = (hit: { start: number; end: number }, context = contextChars) => {
    let start = Math.max(0, hit.start - context);
    let end = Math.min(text.length, hit.end + context);
    // Keep a whole short JSONL event/line when possible; never expand a huge event without bound.
    const lineStart = text.lastIndexOf('\n', hit.start - 1) + 1;
    const newline = text.indexOf('\n', hit.end);
    const lineEnd = newline < 0 ? text.length : newline;
    if (hit.start - lineStart <= context) start = lineStart;
    if (lineEnd - hit.end <= context) end = lineEnd;
    if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]!)) start--;
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end++;
    return {
      offsetChars: start,
      endOffsetChars: end,
      hitOffsetChars: hit.start,
      hitEndOffsetChars: hit.end,
      text: text.slice(start, end),
    };
  };
  return { hits, snippet };
}
