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

import {
  WEB_SEARCH_MAX_LIMIT,
  WEB_SEARCH_PROVIDERS,
  type WebSearchErrorReason,
  type WebSearchResponse,
  type WebSearchResultRow,
} from '@maka/core/web-search';
import {
  requireEncodedByteLimit,
  requireExactRecord,
  requireRecord,
  requireShapedRecord,
  requireUtf8String,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

const WEB_SEARCH_QUERY_MAX_BYTES = 800;
const WEB_SEARCH_SECRET_MAX_BYTES = 16 * 1024;
const WEB_SEARCH_RESULT_MAX_BYTES = 32 * 1024;
const WEB_SEARCH_TEXT_MAX_BYTES = 4 * 1024;
const WEB_SEARCH_ERROR_REASONS: readonly WebSearchErrorReason[] = [
  'invalid_query',
  'incognito_active',
  'not_configured',
  'invalid_credentials',
  'rate_limited',
  'network_error',
  'timeout',
  'unsupported_provider',
  'experimental_disabled',
];
const ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'internal_failure',
] as const;

export type WebSearchExecuteInput =
  | {
      readonly kind: 'query';
      readonly query: string;
      readonly limit: number;
      readonly apiKey?: string;
    }
  | {
      readonly kind: 'test';
      readonly provider: 'tavily';
      readonly apiKey?: string;
    };

export type WebSearchExecuteResult = WebSearchResponse;

export const WEB_SEARCH_OPERATION_SPECS = {
  'web-search.execute': defineOperation<
    WebSearchExecuteInput,
    WebSearchExecuteResult,
    (typeof ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: ERRORS,
    decodeInput: decodeWebSearchExecuteInput,
    decodeOutput: decodeWebSearchExecuteResult,
  }),
} as const;

function decodeWebSearchExecuteInput(value: unknown): WebSearchExecuteInput {
  const record = requireRecord(value, 'Web Search execute input');
  if (record.kind === 'query') {
    const exact = requireShapedRecord(
      record,
      'Web Search query input',
      ['kind', 'query', 'limit'],
      ['apiKey'],
    );
    if (
      !Number.isSafeInteger(exact.limit) ||
      (exact.limit as number) < 1 ||
      (exact.limit as number) > WEB_SEARCH_MAX_LIMIT
    ) {
      throw invalidProtocolFrame('Invalid Web Search result limit');
    }
    return {
      kind: 'query',
      query: requireUtf8String(exact.query, 'Web Search query', WEB_SEARCH_QUERY_MAX_BYTES),
      limit: exact.limit as number,
      ...(exact.apiKey === undefined
        ? {}
        : {
            apiKey: requireUtf8String(
              exact.apiKey,
              'Web Search credential override',
              WEB_SEARCH_SECRET_MAX_BYTES,
            ),
          }),
    };
  }
  if (record.kind === 'test') {
    const exact = requireShapedRecord(
      record,
      'Web Search test input',
      ['kind', 'provider'],
      ['apiKey'],
    );
    if (exact.provider !== 'tavily') {
      throw invalidProtocolFrame('Invalid Web Search test provider');
    }
    return {
      kind: 'test',
      provider: exact.provider,
      ...(exact.apiKey === undefined
        ? {}
        : {
            apiKey: requireUtf8String(
              exact.apiKey,
              'Web Search credential override',
              WEB_SEARCH_SECRET_MAX_BYTES,
            ),
          }),
    };
  }
  throw invalidProtocolFrame('Invalid Web Search execute kind');
}

function decodeWebSearchExecuteResult(value: unknown): WebSearchExecuteResult {
  const record = requireRecord(value, 'Web Search execute result');
  if (record.ok === false) {
    const exact = requireExactRecord(record, 'Web Search error result', [
      'ok',
      'reason',
      'message',
    ]);
    if (
      typeof exact.reason !== 'string' ||
      !WEB_SEARCH_ERROR_REASONS.includes(exact.reason as WebSearchErrorReason)
    ) {
      throw invalidProtocolFrame('Invalid Web Search error reason');
    }
    const result: WebSearchExecuteResult = {
      ok: false,
      reason: exact.reason as WebSearchErrorReason,
      message: requireUtf8String(
        exact.message,
        'Web Search error message',
        WEB_SEARCH_TEXT_MAX_BYTES,
      ),
    };
    requireEncodedByteLimit(result, 'Web Search result', WEB_SEARCH_RESULT_MAX_BYTES);
    return result;
  }
  const exact = requireShapedRecord(
    record,
    'Web Search success result',
    ['ok', 'results'],
    ['provider'],
  );
  if (
    exact.ok !== true ||
    !Array.isArray(exact.results) ||
    exact.results.length > WEB_SEARCH_MAX_LIMIT
  ) {
    throw invalidProtocolFrame('Invalid Web Search success result');
  }
  if (
    exact.provider !== undefined &&
    !WEB_SEARCH_PROVIDERS.includes(exact.provider as (typeof WEB_SEARCH_PROVIDERS)[number])
  ) {
    throw invalidProtocolFrame('Invalid Web Search result provider');
  }
  const results = exact.results.map((row) => decodeWebSearchRow(row));
  const result: WebSearchExecuteResult = {
    ok: true,
    ...(exact.provider === undefined
      ? {}
      : { provider: exact.provider as (typeof WEB_SEARCH_PROVIDERS)[number] }),
    results,
  };
  requireEncodedByteLimit(result, 'Web Search result', WEB_SEARCH_RESULT_MAX_BYTES);
  return result;
}

function decodeWebSearchRow(value: unknown): WebSearchResultRow {
  const row = requireExactRecord(value, 'Web Search result row', [
    'provider',
    'title',
    'url',
    'snippet',
    'source',
  ]);
  if (!WEB_SEARCH_PROVIDERS.includes(row.provider as (typeof WEB_SEARCH_PROVIDERS)[number])) {
    throw invalidProtocolFrame('Invalid Web Search row provider');
  }
  return {
    provider: row.provider as (typeof WEB_SEARCH_PROVIDERS)[number],
    title: requireUtf8String(row.title, 'Web Search result title', WEB_SEARCH_TEXT_MAX_BYTES),
    url: requireUtf8String(row.url, 'Web Search result URL', WEB_SEARCH_TEXT_MAX_BYTES),
    snippet:
      typeof row.snippet === 'string' &&
      Buffer.byteLength(row.snippet, 'utf8') <= WEB_SEARCH_TEXT_MAX_BYTES
        ? row.snippet
        : (() => {
            throw invalidProtocolFrame('Invalid Web Search result snippet');
          })(),
    source: requireUtf8String(row.source, 'Web Search result source', WEB_SEARCH_TEXT_MAX_BYTES),
  };
}
