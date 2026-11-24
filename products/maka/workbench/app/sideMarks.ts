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

/** A side question to mark in the reply it was asked beside. */
export type SideMark = {
  id: string;
  title: string;
  /** The passages it quotes, as they were selected. */
  quotes: readonly string[];
  /** Its card is open. */
  open: boolean;
};

const sideLinkPrefix = 'maka-side:';

/** The side question a link of a marked reply opens, or null for any other link. */
export const sideLinkTarget = (url: string) =>
  url.startsWith(sideLinkPrefix) ? url.slice(sideLinkPrefix.length) : null;

// Ranges of `markdown` a link must stay out of: code (fenced blocks and
// inline spans, where it would show as text), links, autolinks, HTML and URLs.
function blockedRanges(markdown: string): [number, number][] {
  const ranges: [number, number][] = [];
  // A fence may sit under a list item or in a quote, indented as deep as that is.
  const fence =
    /^[ \t>]*(?:(?:[-*+]|\d+[.)])[ \t]+)?(```+|~~~+)[^\n]*\n[\s\S]*?(?:^[ \t>]*\1[^\n]*$|(?![\s\S]))/gm;
  for (const match of markdown.matchAll(fence))
    ranges.push([match.index!, match.index! + match[0].length]);
  for (const pattern of [
    /(`+)[^`]*?\1/g,
    /!?\[[^\]\n]*\]\([^)\n]*\)/g,
    /<[^>\n]+>/g,
    /https?:\/\/\S+/g,
  ])
    for (const match of markdown.matchAll(pattern))
      ranges.push([match.index!, match.index! + match[0].length]);
  return ranges;
}

// Emphasis, strike and code marks, which the rendered text a passage is
// selected from leaves out, and the backslash of an escaped character.
const formatting = /[*_~`]/;
const punctuation = /[!-/:-@[-`{-~]/;
function withoutFormatting(text: string) {
  let plain = '';
  // Where each shown character sits in the source; an escape is one character.
  const spans: [number, number][] = [];
  // A link shows only its text: its brackets and target are left out too.
  const hidden = new Set<number>();
  for (const link of text.matchAll(/(!?\[)([^\]\n]*)\]\([^)\n]*\)/g)) {
    const start = link.index!;
    const textEnd = start + link[1].length + link[2].length;
    for (let at = start; at < start + link[1].length; at += 1) hidden.add(at);
    for (let at = textEnd; at < start + link[0].length; at += 1) hidden.add(at);
  }
  for (let at = 0; at < text.length; at += 1) {
    if (hidden.has(at)) continue;
    if (text[at] === '\\' && punctuation.test(text[at + 1] ?? '')) {
      plain += text[at + 1];
      spans.push([at, at + 2]);
      at += 1;
    } else if (!formatting.test(text[at])) {
      plain += text[at];
      spans.push([at, at + 1]);
    }
  }
  return { plain, spans };
}
// Source text made a link's text: its own brackets escaped, so they show as
// written and do not end the link; escapes already there are kept whole.
function linkText(text: string) {
  let out = '';
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (char === '\\') {
      // A lone backslash at the end would escape the link's closing bracket.
      out += at + 1 < text.length ? char + text[at + 1] : '\\\\';
      at += 1;
    } else out += char === '[' || char === ']' ? `\\${char}` : char;
  }
  return out;
}

/**
 * The reply with each side question's passages made links to it, and the side
 * questions found. A passage is found line by line as it appears in the source;
 * a line that crosses formatting is found without its marks and linked in the
 * pieces between them. Pieces in code stay unmarked. A closed side question's
 * passage is wrapped in `<mark>`, which the reply styles as its own text, so
 * only the link's underline shows; an open one reads as a link.
 */
export function markPassages(
  markdown: string,
  marks: readonly SideMark[],
): { markdown: string; found: ReadonlySet<string> } {
  const found = new Set<string>();
  if (marks.length === 0) return { markdown, found };
  const code = blockedRanges(markdown);
  const taken: [number, number, SideMark][] = [];
  const free = (start: number, end: number) =>
    !code.some(([from, to]) => start < to && end > from) &&
    !taken.some(([from, to]) => start < to && end > from);
  let unformatted: ReturnType<typeof withoutFormatting> | undefined;
  for (const mark of marks) {
    for (const line of mark.quotes.flatMap((quote) => quote.split('\n'))) {
      const text = line.trim();
      if (text.length < 2) continue;
      let direct = false;
      for (let at = markdown.indexOf(text); at >= 0; at = markdown.indexOf(text, at + 1)) {
        if (free(at, at + text.length)) {
          taken.push([at, at + text.length, mark]);
          direct = true;
          break;
        }
      }
      if (direct) continue;
      unformatted ??= withoutFormatting(markdown);
      const { plain, spans } = unformatted;
      const wanted = withoutFormatting(text).plain;
      if (wanted.length < 2) continue;
      for (let at = plain.indexOf(wanted); at >= 0; at = plain.indexOf(wanted, at + 1)) {
        const pieces: [number, number][] = [];
        let start = spans[at][0];
        for (let index = at + 1; index <= at + wanted.length; index += 1) {
          const previous = spans[index - 1];
          if (index === at + wanted.length || spans[index][0] !== previous[1]) {
            pieces.push([start, previous[1]]);
            if (index < at + wanted.length) start = spans[index][0];
          }
        }
        // A piece never crosses a line: a link's text cannot hold a block's end.
        const open = pieces.filter(
          ([from, to]) => free(from, to) && !markdown.slice(from, to).includes('\n'),
        );
        if (open.length === 0) continue;
        for (const [from, to] of open) taken.push([from, to, mark]);
        break;
      }
    }
  }
  let out = markdown;
  for (const [start, end, mark] of taken.sort((a, b) => b[0] - a[0])) {
    found.add(mark.id);
    const text = linkText(out.slice(start, end));
    const title = mark.title.replace(/["\\\n]/g, ' ');
    const shown = mark.open ? text : `<mark>${text}</mark>`;
    out = `${out.slice(0, start)}[${shown}](${sideLinkPrefix}${mark.id} "${title}")${out.slice(end)}`;
  }
  return { markdown: out, found };
}
