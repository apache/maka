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
export type LibraryDraft = {
  searchEngine?: boolean;
  id: string | null;
  kind: LibraryKind;
  name: string;
  value: string;
};

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
  | 'Include {query} in the search URL'
  | 'Enter a name'
  | 'The name is too long'
  | 'Enter some content'
  | 'The content is too long'
  | 'Enter a valid website address';

export function websiteUrl(value: string): string | null {
  const text = value.trim();
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(text) && !/^https?:\/\//i.test(text)) return null;
  const address = /^https?:\/\//i.test(text) ? text : 'https://' + text;
  if (address.length > MAX_URL || /\s|\\/.test(text) || !/^https?:\/\/[^/?#]/i.test(address))
    return null;
  try {
    new URL(address);
    // Keep the template verbatim so {query} can be expanded at launch.
    return address;
  } catch {
    return null;
  }
}

export function draftProblem(draft: LibraryDraft): DraftProblem | null {
  const name = draft.name.trim();
  if (name === '') return 'Enter a name';
  if (name.length > MAX_NAME) return 'The name is too long';
  if (draft.kind === 'link') {
    const url = draft.value.trim();
    if (draft.searchEngine && !url.includes(PLACEHOLDER))
      return 'Include {query} in the search URL';
    return websiteUrl(url) ? null : 'Enter a valid website address';
  }
  if (draft.value.trim() === '') return 'Enter some content';
  return draft.value.length > MAX_CONTENT ? 'The content is too long' : null;
}

export function librarySearchTerms(item: LibraryItem, scoped: boolean): string[] {
  if (item.kind === 'link') {
    const address = item.value.replace(/^https?:\/\/(?:www\.)?/i, '');
    return [item.name, address, item.value];
  }
  return item.kind === 'note' && scoped ? [item.name, item.value] : [item.name];
}

export const isTemplate = (item: LibraryItem) => item.value.includes(PLACEHOLDER);

export const expandLink = (url: string, text: string) =>
  url.replaceAll(PLACEHOLDER, encodeURIComponent(text));
