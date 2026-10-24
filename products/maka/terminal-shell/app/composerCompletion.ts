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

export type Selection = { start: number; end: number };
export type CompletionToken = {
  kind: 'slash' | 'file';
  start: number;
  end: number;
  query: string;
  leading: boolean;
};

const whitespace = (character: string) => /\s/.test(character);
const boundary = (text: string, offset: number) =>
  Number.isInteger(offset) &&
  offset >= 0 &&
  offset <= text.length &&
  !(
    offset > 0 &&
    offset < text.length &&
    text.charCodeAt(offset - 1) >= 0xd800 &&
    text.charCodeAt(offset - 1) <= 0xdbff &&
    text.charCodeAt(offset) >= 0xdc00 &&
    text.charCodeAt(offset) <= 0xdfff
  );
export const validSelection = (text: string, selection: Selection) =>
  selection.start <= selection.end &&
  boundary(text, selection.start) &&
  boundary(text, selection.end);

function quotedPrefix(text: string): string | null {
  // The user may be between the slash and the next character of an escape.
  // Preserve that partial path instead of treating the closing quote as escaped.
  const trailing = text.match(/\\+$/)?.[0].length ?? 0;
  try {
    return JSON.parse(`"${text}${trailing % 2 ? '\\' : ''}"`) as string;
  } catch {
    return null;
  }
}

function tokenAt(text: string, caret: number, start: number): CompletionToken | null {
  const marker = text[start];
  if (
    start >= caret ||
    (marker !== '/' && marker !== '@') ||
    (start > 0 && !whitespace(text[start - 1]))
  )
    return null;
  let end = start + 1;
  let query: string | null;
  if (marker === '@' && text[end] === '"') {
    const content = ++end;
    let closed = false;
    for (; end < text.length && text[end] !== '\r' && text[end] !== '\n'; end++) {
      if (text[end] === '\\') end++;
      else if (text[end] === '"') {
        closed = true;
        break;
      }
    }
    if (closed) end++;
    // An unfinished quote does not identify where untouched following prose
    // ends. Only replace its typed prefix until a closing quote exists.
    else {
      if (end < caret) return null;
      end = caret;
    }
    if (caret > end) return null;
    const prefixEnd = closed ? Math.min(caret, end - 1) : caret;
    query = quotedPrefix(text.slice(content, Math.max(content, prefixEnd)));
  } else if (marker === '/') {
    const name = /[\p{L}\p{N}\p{M}._:-]*/uy;
    name.lastIndex = end;
    name.exec(text);
    end = name.lastIndex;
    if (caret > end || text[end] === '/') return null;
    query = text.slice(start + 1, caret).replace(/^skill:/, '');
  } else {
    while (end < text.length && !whitespace(text[end]) && text[end] !== '"') end++;
    if (caret > end) return null;
    query = text.slice(start + 1, caret);
  }
  if (query === null) return null;
  return {
    kind: marker === '/' ? 'slash' : 'file',
    start,
    end,
    query,
    leading: text.search(/\S/) === start,
  };
}

function quotedStart(text: string, before: number): number {
  if (before <= 0) return -1;
  let start = text.lastIndexOf('@"', before - 1);
  while (start > 0 && !whitespace(text[start - 1])) start = text.lastIndexOf('@"', start - 1);
  return start;
}

/** Finds a completion at the actual UTF-16 caret, including its remaining suffix. */
export function completionToken(text: string, selection: Selection): CompletionToken | null {
  if (!validSelection(text, selection) || selection.start !== selection.end) return null;
  const caret = selection.start;
  const quoted = quotedStart(text, caret);
  let excluded = -1;
  if (quoted >= 0) {
    // A quoted filename may contain spaces and even a final " @". In that
    // case the nearest @" is the outer reference's closing quote.
    const previous = quotedStart(text, quoted);
    const enclosing = previous >= 0 ? tokenAt(text, quoted + 1, previous) : null;
    if (enclosing && enclosing.end > quoted) {
      const outer = tokenAt(text, caret, previous);
      if (outer) return outer;
      excluded = quoted;
    } else {
      const token = tokenAt(text, caret, quoted);
      if (token) return token;
    }
  }
  let start = caret;
  while (start > 0 && !whitespace(text[start - 1])) start--;
  return start === excluded ? null : tokenAt(text, caret, start);
}

/** One native replacement keeps the existing prose and supplies token boundaries. */
export function referenceEdit(
  text: string,
  selection: Selection,
  token: CompletionToken | null,
  insert: string,
): { start: number; end: number; text: string } {
  const range = token ?? selection;
  if (!validSelection(text, selection) || !validSelection(text, range))
    throw new RangeError('Invalid UTF-16 completion range.');
  const { start } = range;
  let { end } = range;
  if (!insert) return { start, end, text: '' };
  const before = start > 0 && !whitespace(text[start - 1]) ? ' ' : '';
  let after = ' ';
  if (end < text.length && whitespace(text[end])) {
    // Reuse the existing separator so the native caret lands after it rather
    // than letting the next character join the completed reference.
    after = text[end++];
    if (after === '\r' && text[end] === '\n') after += text[end++];
  }
  return { start, end, text: before + insert + after };
}

/** File references remain text; quoting preserves spaces and literal path characters. */
export function fileInvocation(path: string): string {
  return '@' + (!path || /[\s"'\\\u0000-\u001f\u007f]/.test(path) ? JSON.stringify(path) : path);
}
