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

import { urlSource, type AnswerSource } from './answerCitations';
import { record } from './toolCards';

const queryFields = [
  'queries',
  'query',
  'q',
  'search_query',
  'searchQuery',
  'search_queries',
  'searchQueries',
  'search_terms',
  'searchTerms',
  'keywords',
] as const;

// A few gateways wrap the native JSON in a text content block.
function structured(value: unknown): unknown {
  if (typeof value !== 'string' || !/^[{\[]/.test(value.trimStart())) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function providerSearch(input: unknown, output: unknown) {
  const queries = new Set<string>();
  const sources = new Map<string, AnswerSource>();
  let error: string | null = null;
  const addQuery = (value: unknown) => {
    if (typeof value === 'string') {
      if (value.trim()) queries.add(value.trim());
    } else if (Array.isArray(value)) {
      value.forEach(addQuery);
    } else {
      const row = record(value);
      if (row) for (const field of queryFields) if (row[field] != null) addQuery(row[field]);
    }
  };
  const addSource = (value: unknown) => {
    const row = record(value);
    const target =
      typeof value === 'string' ? value : (row?.url ?? row?.link ?? row?.href ?? row?.uri);
    if (typeof target !== 'string') return;
    const label = row?.title ?? row?.name;
    const source = urlSource(target, typeof label === 'string' ? label : undefined);
    if (source.url && !sources.has(source.key)) sources.set(source.key, source);
  };
  const readResult = (value: unknown) => {
    const parsed = structured(value);
    if (Array.isArray(parsed)) {
      for (const hit of parsed) {
        const item = record(hit);
        if (item?.type === 'text') readResult(item.text);
        else addSource(hit);
      }
      return;
    }
    const row = record(parsed);
    if (!row) return;
    addQuery(row);
    if (row.type === 'find' || row.type === 'find_in_page') addQuery(row.pattern);
    addSource(row);
    const failure = row.error_code ?? record(row.error)?.message;
    if (typeof failure === 'string') error = failure;
    for (const field of [
      'sources',
      'results',
      'search_results',
      'searchResults',
      'citations',
      'items',
      'organic',
      'organic_results',
    ]) {
      if (Array.isArray(row[field])) row[field].forEach(addSource);
    }
    const webPages = record(row.webPages)?.value;
    if (Array.isArray(webPages)) webPages.forEach(addSource);
    for (const field of ['action', 'data', 'result', 'content']) {
      if (row[field] != null) readResult(row[field]);
    }
  };
  addQuery(structured(input));
  readResult(output);
  return { queries: [...queries], sources: [...sources.values()], error };
}
