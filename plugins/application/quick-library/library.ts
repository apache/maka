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

export type LibraryKind = 'snippet' | 'note' | 'link';
export type LibraryItem = { id: string; kind: LibraryKind; name: string; value: string };
export type LibraryDraft = { id: string | null; kind: LibraryKind; name: string; value: string };

const MAX_NAME = 160;
const MAX_CONTENT = 100_000;
const MAX_URL = 4096;
const PLACEHOLDER = '{query}';

/** The stored list, or an error: damaged data must not be overwritten as if it were empty. */
export function parseLibrary(stored: string | null): LibraryItem[] {
  if (stored === null) return [];
  const value: unknown = JSON.parse(stored);
  if (!Array.isArray(value)) throw new Error('The saved quick library is damaged.');
  return value as LibraryItem[];
}

export type DraftProblem =
  | 'Enter a name'
  | 'The name is too long'
  | 'Enter some content'
  | 'The content is too long'
  | 'Enter a URL starting with http:// or https://';

export function draftProblem(draft: LibraryDraft): DraftProblem | null {
  const name = draft.name.trim();
  if (name === '') return 'Enter a name';
  if (name.length > MAX_NAME) return 'The name is too long';
  if (draft.kind === 'link') {
    const url = draft.value.trim();
    return /^https?:\/\/\S+$/i.test(url) && url.length <= MAX_URL
      ? null
      : 'Enter a URL starting with http:// or https://';
  }
  if (draft.value.trim() === '') return 'Enter some content';
  return draft.value.length > MAX_CONTENT ? 'The content is too long' : null;
}

export const isTemplate = (item: LibraryItem) => item.value.includes(PLACEHOLDER);

export const expandLink = (url: string, text: string) =>
  url.replaceAll(PLACEHOLDER, encodeURIComponent(text));
