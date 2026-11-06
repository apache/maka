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

import { messageBytes } from './history.ts';

// Keep the whitespace boundary identical to the host's skill invocation grammar.
export const SKILL_TOKEN_PATTERN = String.raw`(?:^|[\t-\r \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}])(?P<token>/skill:(?P<label>[A-Za-z0-9._-]+))`;

/** Loaded gaps remain separate source regions. */
export function skillTextGroups(fragments: readonly { offset: number; text: string }[]) {
  const groups: { offset: number; text: string }[] = [];
  let next = -1;
  for (const fragment of fragments) {
    if (fragment.offset === next) groups[groups.length - 1].text += fragment.text;
    else groups.push({ ...fragment });
    next = fragment.offset + messageBytes(fragment.text);
  }
  return groups;
}

/** A loaded suffix cannot establish the boundary before its first character. */
export function hasSkillToken(group: { text: string; offset: number }): boolean {
  const pattern = new RegExp(SKILL_TOKEN_PATTERN.replaceAll('(?P<', '(?<'), 'gu');
  for (const found of group.text.matchAll(pattern)) {
    const token = found.groups!.token;
    const start = found.index + found[0].length - token.length;
    if (start > 0 || group.offset === 0) return true;
  }
  return false;
}
