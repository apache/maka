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

export function providerSearch(input: unknown, output: unknown) {
  const args = record(input);
  const result = record(output);
  const action = record(result?.action);
  const queries = new Set<string>();
  const sources = new Map<string, AnswerSource>();
  const addQuery = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) queries.add(value.trim());
  };
  addQuery(args?.query);
  if (Array.isArray(action?.queries)) action.queries.forEach(addQuery);
  addQuery(action?.query);
  if (action?.type === 'find' || action?.type === 'find_in_page') addQuery(action.pattern);

  const addSource = (value: unknown) => {
    const row = record(value);
    if (typeof row?.url !== 'string') return;
    const source = urlSource(row.url, typeof row.title === 'string' ? row.title : undefined);
    if (source.url && !sources.has(source.key)) sources.set(source.key, source);
  };
  if (Array.isArray(output)) output.forEach(addSource);
  if (Array.isArray(action?.sources)) action.sources.forEach(addSource);
  if (action?.url) addSource(action);

  return {
    queries: [...queries],
    sources: [...sources.values()],
    error: typeof result?.error_code === 'string' ? result.error_code : null,
  };
}
