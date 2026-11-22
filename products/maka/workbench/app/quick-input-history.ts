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

export function rememberInput(entries: string[], text: string): string[] {
  const value = text.trim();
  return !value || value.length > 32000
    ? entries
    : [...entries.filter((entry) => entry !== value), value].slice(-50);
}
export function recallInput(
  entries: string[],
  index: number,
  draft: string,
  current: string,
  direction: -1 | 1,
) {
  const savedDraft = index < 0 ? current : draft;
  const next = Math.max(-1, Math.min(entries.length - 1, index + direction));
  return {
    index: next,
    draft: savedDraft,
    text: next < 0 ? savedDraft : entries[entries.length - 1 - next],
  };
}

// Return null when the arrow belongs to the results list.
export function historyAtSelection(
  entries: string[],
  selected: number,
  cursor: ReturnType<typeof recallInput>,
  current: string,
  direction: -1 | 1,
) {
  if (selected !== 0 || !entries.length || (direction === 1 && cursor.index < 0)) return null;
  return recallInput(entries, cursor.index, cursor.draft, current, direction === -1 ? 1 : -1);
}
