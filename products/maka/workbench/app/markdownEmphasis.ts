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
 * after it is whitespace or punctuation. Chinese is written without spaces, so
 * `**回升能否守住：**如果…` never closes and the asterisks show as text. Where a pair would
 * fail for that reason, the punctuation at the edge of the bold text moves outside the
 * markers (`**回升能否守住**：如果…`): the visible text is the same and the pair closes.
 *
 * Only a `**…**` pair inside one line of ordinary text is touched; fenced code, inline
 * code and anything already written correctly are left as they are.
 */
const EDGE = /[\p{P}\p{S}]/u;
const MOVABLE = (char: string) => EDGE.test(char) && char !== '*' && char !== '`' && char !== '\\';
const BLANK = /\s/u;
const closesOn = (next: string | undefined) =>
  next === undefined || BLANK.test(next) || EDGE.test(next);
const opensAfter = (previous: string | undefined) =>
  previous === undefined || BLANK.test(previous) || EDGE.test(previous);

function fixPairs(text: string): string {
  return text.replace(/\*\*([^*\n]+?)\*\*/gu, (whole, inner: string, offset: number) => {
    const before = [...text.slice(0, offset)].at(-1);
    const after = [...text.slice(offset + whole.length)][0];
    const chars = [...inner];
    let leading = '';
    let trailing = '';
    // Closing: punctuation inside the end marker while a letter or character follows it.
    if (!closesOn(after))
      while (chars.length > 1 && MOVABLE(chars.at(-1)!)) trailing = chars.pop()! + trailing;
    // Opening: punctuation inside the start marker while a letter or character precedes it.
    if (!opensAfter(before))
      while (chars.length > 1 && MOVABLE(chars[0])) leading += chars.shift()!;
    if (!leading && !trailing) return whole;
    // Nothing left to be bold: leave the text as written.
    if (chars.every((char) => MOVABLE(char) || BLANK.test(char))) return whole;
    return `${leading}**${chars.join('')}**${trailing}`;
  });
}

/** `text` with bold pairs that CommonMark would leave open made to close, outside code. */
export function closeCjkEmphasis(text: string): string {
  if (!text.includes('**')) return text;
  let fenced: string | null = null;
  return text
    .split('\n')
    .map((line) => {
      const fence = /^\s{0,3}(`{3,}|~{3,})/u.exec(line);
      if (fenced !== null) {
        if (fence && fence[1][0] === fenced[0] && fence[1].length >= fenced.length) fenced = null;
        return line;
      }
      if (fence) {
        fenced = fence[1];
        return line;
      }
      // Inline code spans stay as written; the text between them is fixed.
      return line
        .split(/(`+[^`]*`+)/u)
        .map((part, index) => (index % 2 === 1 ? part : fixPairs(part)))
        .join('');
    })
    .join('\n');
}
