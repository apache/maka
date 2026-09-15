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

import type {
  ComputerHistorySummaryContent,
  ComputerHistorySummaryInput,
} from '@maka/core/computer-history';
import { isUiLocale } from '@maka/core/ui-locale';
import {
  requireEncodedByteLimit,
  requireExactRecord,
  requireShapedRecord,
  requireUtf8String,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const COMPUTER_HISTORY_INPUT_MAX_BYTES = 256 * 1024;
export const COMPUTER_HISTORY_EVIDENCE_MAX_ITEMS = 256;
export const COMPUTER_HISTORY_EVIDENCE_TEXT_MAX_BYTES = 32 * 1024;
export const COMPUTER_HISTORY_PRIOR_CONTEXT_MAX_ITEMS = 2;
export const COMPUTER_HISTORY_RESULT_MAX_BYTES = 64 * 1024;
export const COMPUTER_HISTORY_BODY_MAX_BYTES = 48 * 1024;
export const COMPUTER_HISTORY_KEYWORDS_MAX_ITEMS = 10;
export const COMPUTER_HISTORY_KEYWORD_MAX_BYTES = 96;

export const COMPUTER_HISTORY_OPERATION_SPECS = {
  'computer-history.summarize': defineOperation<
    ComputerHistorySummaryInput,
    ComputerHistorySummaryContent,
    | 'host_not_ready'
    | 'host_draining'
    | 'operation_unavailable'
    | 'operation_conflict'
    | 'invalid_request'
    | 'model_unavailable'
    | 'invalid_summary'
    | 'persistence_failed'
    | 'internal_failure'
  >({
    mode: 'command',
    availability: 'ready',
    cancellable: true,
    errors: [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'operation_conflict',
      'invalid_request',
      'model_unavailable',
      'invalid_summary',
      'persistence_failed',
      'internal_failure',
    ],
    decodeInput: decodeComputerHistorySummaryInput,
    decodeOutput: decodeComputerHistorySummaryContent,
  }),
} as const;

export function decodeComputerHistorySummaryInput(value: unknown): ComputerHistorySummaryInput {
  const input = requireShapedRecord(
    value,
    'Computer History summary input',
    ['level', 'start', 'end', 'evidence'],
    ['locale', 'priorContext'],
  );
  if (input.level !== '10min' && input.level !== '6h') {
    throw invalidProtocolFrame('Invalid Computer History summary level');
  }
  if (input.locale !== undefined && !isUiLocale(input.locale)) {
    throw invalidProtocolFrame('Invalid Computer History summary locale');
  }
  const start = requireTimestamp(input.start);
  const end = requireTimestamp(input.end);
  const duration = Date.parse(end) - Date.parse(start);
  const maxDuration = input.level === '10min' ? 10 * 60_000 : 6 * 60 * 60_000;
  if (duration <= 0 || duration > maxDuration) {
    throw invalidProtocolFrame('Invalid Computer History summary time range');
  }
  if (
    !Array.isArray(input.evidence) ||
    input.evidence.length === 0 ||
    input.evidence.length > COMPUTER_HISTORY_EVIDENCE_MAX_ITEMS
  ) {
    throw invalidProtocolFrame('Invalid Computer History evidence count');
  }
  requireEncodedByteLimit(
    input,
    'Computer History summary input',
    COMPUTER_HISTORY_INPUT_MAX_BYTES,
  );
  const ids = new Set<string>();
  const decodeEvidence = (value: unknown) => {
    const entry = requireExactRecord(value, 'Computer History evidence', ['id', 'text']);
    const id = requireText(entry.id, 'Computer History evidence id', 128);
    if (ids.has(id)) throw invalidProtocolFrame('Duplicate Computer History evidence id');
    ids.add(id);
    return {
      id,
      text: requireText(
        entry.text,
        'Computer History evidence text',
        COMPUTER_HISTORY_EVIDENCE_TEXT_MAX_BYTES,
      ),
    };
  };
  const evidence = input.evidence.map(decodeEvidence);
  let priorContext: ComputerHistorySummaryInput['priorContext'];
  if (input.priorContext !== undefined) {
    if (
      !Array.isArray(input.priorContext) ||
      input.priorContext.length > COMPUTER_HISTORY_PRIOR_CONTEXT_MAX_ITEMS
    ) {
      throw invalidProtocolFrame('Invalid Computer History prior context count');
    }
    priorContext = input.priorContext.map(decodeEvidence);
  }
  return {
    level: input.level,
    start,
    end,
    evidence,
    ...(input.locale === undefined ? {} : { locale: input.locale }),
    ...(priorContext === undefined ? {} : { priorContext }),
  };
}

export function decodeComputerHistorySummaryContent(value: unknown): ComputerHistorySummaryContent {
  const output = requireShapedRecord(
    value,
    'Computer History summary content',
    ['title', 'description', 'body'],
    ['keywords', 'suggestion'],
  );
  requireEncodedByteLimit(
    output,
    'Computer History summary content',
    COMPUTER_HISTORY_RESULT_MAX_BYTES,
  );
  const keywords = output.keywords === undefined ? undefined : decodeKeywords(output.keywords);
  if (keywords !== undefined) {
    // NFKC may expand terms, so the normalized wire result must fit the same budget.
    requireEncodedByteLimit(
      { ...output, keywords },
      'Computer History summary content',
      COMPUTER_HISTORY_RESULT_MAX_BYTES,
    );
  }
  const content = {
    title: requireText(output.title, 'Computer History summary title', 512),
    description: requireText(output.description, 'Computer History summary description', 2 * 1024),
    body: requireText(
      output.body,
      'Computer History summary body',
      COMPUTER_HISTORY_BODY_MAX_BYTES,
    ),
    ...(keywords === undefined ? {} : { keywords }),
  };
  if (output.suggestion === undefined) return content;
  const suggestion = requireExactRecord(output.suggestion, 'Computer History suggestion', [
    'type',
    'name',
    'description',
  ]);
  if (suggestion.type !== 'skill' && suggestion.type !== 'automation') {
    throw invalidProtocolFrame('Invalid Computer History suggestion type');
  }
  return {
    ...content,
    suggestion: {
      type: suggestion.type,
      name: requireText(suggestion.name, 'Computer History suggestion name', 256),
      description: requireText(
        suggestion.description,
        'Computer History suggestion description',
        2 * 1024,
      ),
    },
  };
}

function decodeKeywords(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > COMPUTER_HISTORY_KEYWORDS_MAX_ITEMS) {
    throw invalidProtocolFrame('Invalid Computer History keyword count');
  }
  const keywords: string[] = [];
  const seen = new Set<string>();
  const forbidden = /[\p{Cc}\p{Cf}<>]/u;
  for (const entry of value) {
    // Reject controls before trimming and delimiters exposed by normalization.
    if (typeof entry !== 'string' || forbidden.test(entry)) {
      throw invalidProtocolFrame('Invalid Computer History keyword');
    }
    const keyword = requireText(
      entry.normalize('NFKC').trim(),
      'Computer History keyword',
      COMPUTER_HISTORY_KEYWORD_MAX_BYTES,
    );
    if (forbidden.test(keyword)) {
      throw invalidProtocolFrame('Invalid Computer History keyword');
    }
    const key = keyword.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      keywords.push(keyword);
    }
  }
  return keywords;
}

function requireTimestamp(value: unknown): string {
  const timestamp = requireUtf8String(value, 'Computer History timestamp', 24);
  const ms = Date.parse(timestamp);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== timestamp) {
    throw invalidProtocolFrame('Computer History timestamps must be canonical UTC ISO strings');
  }
  return timestamp;
}

function requireText(value: unknown, label: string, maxBytes: number): string {
  const text = requireUtf8String(value, label, maxBytes);
  if (!text.trim()) throw invalidProtocolFrame(`Invalid ${label}`);
  return text;
}
