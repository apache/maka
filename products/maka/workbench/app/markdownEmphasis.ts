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
 * CommonMark closes `**` only if the character before it is not punctuation, or the one
 * after it is whitespace or punctuation (and mirrored for opening). Chinese is written
 * without spaces, so `**回升能否守住：**如果…` never closes and its asterisks show as text.
 *
 * Where a `**…**` pair fails for that reason, the punctuation at the edge of the bold text
 * moves outside the markers (`**回升能否守住**：如果…`): the visible text is the same and
 * the pair closes. A balanced wrapper that surrounds the bold text moves out as a pair
 * (`他说**“不行”**然后` → `他说“**不行**”然后`), so nothing is half bold.
 *
 * This is a text pass, not a parser, so it only rewrites what it can recognise as plain
 * prose and leaves every other case exactly as written: fenced and indented code, code
 * spans (including ones that run over lines), escapes, link destinations, reference
 * definitions, autolinks, raw URLs and HTML tags. A pair it cannot move without splitting
 * bold text (`**营收（同比 +12%）**增长`) is left as written too.
 */

/** Punctuation that ends a clause or label and is safe to move out of the bold text. */
const PEEL = new Set(['：', ':', '，', ',', '。', '.', '；', ';', '、', '！', '!', '？', '?']);
const OPENERS = '“‘《【「『（([〈«{';
const CLOSERS = '”’》】」』）)]〉»}';
const isPunctuation = (char: string) => /[\p{P}\p{S}]/u.test(char);
const isBlank = (char: string) => /\s/u.test(char);
const closesOn = (next: string | undefined) =>
  next === undefined || isBlank(next) || isPunctuation(next);
const opensAfter = (previous: string | undefined) =>
  previous === undefined || isBlank(previous) || isPunctuation(previous);
const wraps = (open: string, close: string) =>
  OPENERS.includes(open) && OPENERS.indexOf(open) === CLOSERS.indexOf(close);

type Range = readonly [number, number];

/** The parts of a paragraph that are not plain prose: they are never read or rewritten. */
function protectedRanges(text: string): Range[] {
  const found: Range[] = [];
  // Reference definitions are whole lines.
  for (const match of text.matchAll(/^ {0,3}\[[^\]\n]+\]:.*$/gmu))
    found.push([match.index, match.index + match[0].length]);
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      found.push([index, Math.min(index + 2, text.length)]);
      index += 2;
    } else if (char === '`') {
      let end = index;
      while (text[end] === '`') end += 1;
      const length = end - index;
      // A span closes at the next run of exactly the same length, even over lines.
      let close = -1;
      for (let at = end; at < text.length; ) {
        if (text[at] !== '`') {
          at += 1;
          continue;
        }
        let stop = at;
        while (text[stop] === '`') stop += 1;
        if (stop - at === length) {
          close = stop;
          break;
        }
        at = stop;
      }
      if (close === -1) {
        found.push([index, end]);
        index = end;
      } else {
        found.push([index, close]);
        index = close;
      }
    } else if (char === '<') {
      const tag =
        /^<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[^\s@<>]+@[^\s<>]+|\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?|!--[\s\S]*?--)>/u.exec(
          text.slice(index),
        );
      if (tag) {
        found.push([index, index + tag[0].length]);
        index += tag[0].length;
      } else index += 1;
    } else if (char === ']' && text[index + 1] === '(') {
      // A link or image destination, with balanced parentheses.
      let depth = 0;
      let end = index + 1;
      for (; end < text.length && text[end] !== '\n'; end += 1) {
        if (text[end] === '(') depth += 1;
        else if (text[end] === ')' && --depth === 0) break;
      }
      found.push([index + 1, Math.min(end + 1, text.length)]);
      index = Math.min(end + 1, text.length);
    } else {
      const url = /^(?:https?:\/\/|www\.)[^\s<]*/iu.exec(text.slice(index));
      if (url) {
        found.push([index, index + url[0].length]);
        index += url[0].length;
      } else index += 1;
    }
  }
  return found;
}

function wrapsAll(chars: readonly string[]): boolean {
  if (chars.length <= 2) return false;
  const open = chars[0];
  const close = chars.at(-1)!;
  if (!wraps(open, close)) return false;
  let depth = 0;
  for (let index = 0; index < chars.length - 1; index += 1) {
    if (chars[index] === open) depth += 1;
    else if (chars[index] === close && --depth === 0) return false;
  }
  return depth === 1;
}

const inside = (ranges: readonly Range[], at: number) =>
  ranges.some(([start, end]) => at >= start && at < end);

type Edit = { start: number; end: number; text: string };

/** The rewritten `**body**` for one pair, or null when it should stay as written. */
function repair(paragraph: string, open: number, close: number, ranges: readonly Range[]) {
  const before = open > 0 ? [...paragraph.slice(Math.max(0, open - 2), open)].at(-1) : undefined;
  const after = [...paragraph.slice(close + 2, close + 4)][0];
  const chars = [...paragraph.slice(open + 2, close)];
  if (chars.length === 0 || isBlank(chars[0]) || isBlank(chars.at(-1)!)) return null;
  const blockedClose = isPunctuation(chars.at(-1)!) && !closesOn(after);
  const blockedOpen = isPunctuation(chars[0]) && !opensAfter(before);
  if (!blockedClose && !blockedOpen) return null;

  let bodyStart = open + 2;
  let bodyEnd = close;
  let leading = '';
  let trailing = '';

  // Peel trailing clause/label punctuation (`PEEL`) that is plain prose.
  while (chars.length > 1 && PEEL.has(chars.at(-1)!)) {
    const char = chars.at(-1)!;
    if (inside(ranges, bodyEnd - char.length)) break;
    chars.pop();
    bodyEnd -= char.length;
    trailing = char + trailing;
  }

  // A balanced wrapper around the remaining bold text moves out as a pair when an edge is blocked.
  const firstAfter = [...trailing][0] ?? after;
  const stillBlockedClose = isPunctuation(chars.at(-1)!) && !closesOn(firstAfter);
  const stillBlockedOpen = isPunctuation(chars[0]) && !opensAfter(before);
  if (
    (stillBlockedOpen || stillBlockedClose) &&
    wrapsAll(chars) &&
    !inside(ranges, bodyStart) &&
    !inside(ranges, bodyEnd - chars.at(-1)!.length)
  ) {
    const openWrap = chars.shift()!;
    const closeWrap = chars.pop()!;
    bodyStart += openWrap.length;
    bodyEnd -= closeWrap.length;
    leading = openWrap;
    trailing = closeWrap + trailing;
  }

  if (
    chars.length === 0 ||
    isBlank(chars[0]) ||
    isBlank(chars.at(-1)!) ||
    chars.every((char) => isPunctuation(char) || isBlank(char))
  ) {
    return null;
  }
  // The pair must now be able to open and to close under CommonMark flank rules.
  const openBefore = leading ? [...leading].at(-1) : before;
  const closeAfter = trailing ? [...trailing][0] : after;
  if (isPunctuation(chars[0]) && !opensAfter(openBefore)) return null;
  if (isPunctuation(chars.at(-1)!) && !closesOn(closeAfter)) return null;
  return `${leading}**${chars.join('')}**${trailing}`;
}

/** One paragraph (no blank line, no fence): pair its `**` runs on each line and repair them. */
function fixParagraph(paragraph: string): string {
  const ranges = protectedRanges(paragraph);
  const edits: Edit[] = [];
  let pending: number | null = null;
  for (let index = 0; index < paragraph.length; ) {
    if (paragraph[index] === '\n') {
      pending = null;
      index += 1;
      continue;
    }
    if (paragraph[index] !== '*') {
      index += 1;
      continue;
    }
    let end = index;
    while (paragraph[end] === '*') end += 1;
    const length = end - index;
    const at = index;
    index = end;
    if (inside(ranges, at)) continue;
    // Only a plain `**`; longer or shorter runs are left alone and end any open pair.
    if (length !== 2) {
      pending = null;
      continue;
    }
    const next = [...paragraph.slice(at + 2, at + 4)][0];
    const previous = at > 0 ? [...paragraph.slice(Math.max(0, at - 2), at)].at(-1) : undefined;
    const canClose = previous !== undefined && !isBlank(previous);
    const canOpen =
      next !== undefined &&
      next !== '\n' &&
      !isBlank(next) &&
      (!isPunctuation(next) || opensAfter(previous) || OPENERS.includes(next));
    if (canClose && pending !== null) {
      const text = repair(paragraph, pending, at, ranges);
      if (text !== null) edits.push({ start: pending, end: at + 2, text });
      pending = null;
    } else if (canOpen) pending = at;
  }
  let result = paragraph;
  for (const edit of edits.reverse())
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}

/** Strips the container prefixes (`>`, list markers) a fence line may sit behind. */
const FENCE_PREFIX = String.raw`(?:[ \t]*>)*[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)?`;
const FENCE_OPEN = new RegExp(`^${FENCE_PREFIX}(\`{3,}|~{3,})(.*)$`, 'u');
const THEMATIC_BREAK = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/u;
const LIST_ITEM = /^([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/u;

function advanceCols(cols: number, text: string): number {
  let current = cols;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === ' ') current += 1;
    else if (text[index] === '\t') current += 4 - (current % 4);
    else break;
  }
  return current;
}

function lineIndent(line: string): { cols: number; offset: number } {
  let cols = 0;
  let offset = 0;
  while (offset < line.length) {
    if (line[offset] === ' ') {
      cols += 1;
      offset += 1;
    } else if (line[offset] === '\t') {
      cols += 4 - (cols % 4);
      offset += 1;
    } else {
      break;
    }
  }
  return { cols, offset };
}

/**
 * Constructs whose literal body this line-by-line scan does not track: indented code inside
 * a container, and raw HTML blocks whose body can run across blank lines. A reply that has
 * one is left exactly as written, so the worst case is a stray asterisk and never a changed
 * code body.
 */
const RAW_HTML_BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|ol|p|pre|script|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|textarea|ul|style';
const UNMODELLED = new RegExp(
  String.raw`^[ \t]*(?:(?:>[ \t]*)|(?:[-*+]|\d{1,9}[.)])[ \t]+)+(?: {4,}|\t)|<(?:(?:${RAW_HTML_BLOCK_TAGS})\b)|<!--|<\?|<![A-Z]|<!\[CDATA\[`,
  'imu',
);

/**
 * `text` with bold pairs that CommonMark would leave open made to close. Fenced and
 * indented code blocks are skipped; the rest is rewritten paragraph by paragraph.
 */
export function closeCjkEmphasis(text: string): string {
  if (!text.includes('**') || UNMODELLED.test(text)) return text;
  const lines = text.split('\n');
  const out: string[] = [];
  let fence: string | null = null;
  let indentedCodeCols: number | null = null;
  const listStack: number[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) out.push(...fixParagraph(paragraph.join('\n')).split('\n'));
    paragraph = [];
  };
  for (const line of lines) {
    if (fence !== null) {
      const closing = new RegExp(
        `^${FENCE_PREFIX}(\`{${fence.length},}|~{${fence.length},})[ \\t]*$`,
        'u',
      ).exec(line);
      if (closing && closing[1][0] === fence[0]) fence = null;
      out.push(line);
      continue;
    }
    if (indentedCodeCols !== null) {
      if (line.trim() === '' || lineIndent(line).cols >= indentedCodeCols) {
        out.push(line);
        continue;
      }
      indentedCodeCols = null;
    }
    if (line.trim() === '') {
      flush();
      out.push(line);
      continue;
    }
    const { cols, offset } = lineIndent(line);
    while (listStack.length > 0 && listStack.at(-1)! > cols) listStack.pop();
    const baseIndent = listStack.at(-1) ?? 0;
    if (paragraph.length === 0 && cols >= baseIndent + 4) {
      indentedCodeCols = baseIndent + 4;
      out.push(line);
      continue;
    }
    const opening = FENCE_OPEN.exec(line);
    // A backtick fence's info string cannot contain a backtick: that is an inline span.
    if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
      flush();
      fence = opening[1];
      out.push(line);
      continue;
    }
    const rest = line.slice(offset);
    if (!THEMATIC_BREAK.test(rest)) {
      const item = LIST_ITEM.exec(rest);
      if (item && (item[2] !== undefined || rest.length === item[1].length)) {
        const markerEnd = cols + item[1].length;
        const contentCols = item[2] ? advanceCols(markerEnd, item[2]) : markerEnd + 1;
        const indent = !item[3] || contentCols - markerEnd >= 5 ? markerEnd + 1 : contentCols;
        listStack.push(indent);
      }
    }
    paragraph.push(line);
  }
  flush();
  return out.join('\n');
}
