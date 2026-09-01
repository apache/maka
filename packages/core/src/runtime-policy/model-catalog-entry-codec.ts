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

import { isThinkingLevel, type ThinkingLevel } from '../model-thinking.js';
import type { ModelCatalogEntry, ModelCatalogPricing } from '../model-catalog.js';
import { decodeConnectionModel } from './connection-catalog-codec.js';
import { booleanValue, domainError, exactRecord, stringValue } from './domain-codec.js';

const PRICING_SOURCES = ['builtin', 'user_override'] as const;

/**
 * A catalog entry as the Host resolved it. The entry is a projection, not
 * stored state: the Host owns the metadata that produced it, so a client
 * decodes what it was sent rather than re-deriving it from a bundled copy
 * that may be older or newer than the Host's.
 */
export function decodeModelCatalogEntry(value: unknown): ModelCatalogEntry {
  const item = exactRecord(
    value,
    'model catalog entry',
    [
      'id',
      'displayName',
      'description',
      'canUseAsChatDefault',
      'isDefault',
      'supportsVision',
      'thinkingLevels',
      'contextWindow',
      'knowledgeCutoff',
      'pricing',
    ],
    ['id', 'canUseAsChatDefault', 'isDefault', 'supportsVision', 'thinkingLevels'],
  );
  // The fields an entry shares with a stored model row keep one decoder, so a
  // bound that moves moves for both. `decodeConnectionModel` rejects unknown
  // fields, so it is handed exactly the subset it owns.
  const shared = decodeConnectionModel({
    id: item.id,
    ...pick(item, ['displayName', 'description', 'contextWindow', 'knowledgeCutoff']),
  });
  return {
    ...shared,
    canUseAsChatDefault: booleanValue(item.canUseAsChatDefault, 'entry chat default eligibility'),
    isDefault: booleanValue(item.isDefault, 'entry default flag'),
    supportsVision: booleanValue(item.supportsVision, 'entry vision support'),
    thinkingLevels: decodeThinkingLevels(item.thinkingLevels),
    ...(item.pricing === undefined ? {} : { pricing: decodePricing(item.pricing) }),
  };
}

function decodeThinkingLevels(value: unknown): readonly ThinkingLevel[] {
  if (!Array.isArray(value)) throw domainError('entry thinking levels must be an array');
  const levels = value.map((level) => {
    if (!isThinkingLevel(level)) throw domainError('entry thinking level is invalid');
    return level;
  });
  if (new Set(levels).size !== levels.length) {
    throw domainError('entry thinking levels must be unique');
  }
  return levels;
}

function decodePricing(value: unknown): ModelCatalogPricing {
  const item = exactRecord(
    value,
    'entry pricing',
    ['inputUsdPer1M', 'outputUsdPer1M', 'cacheReadUsdPer1M', 'cacheWriteUsdPer1M', 'source'],
    ['inputUsdPer1M', 'outputUsdPer1M', 'source'],
  );
  return {
    inputUsdPer1M: priceValue(item.inputUsdPer1M, 'entry input price'),
    outputUsdPer1M: priceValue(item.outputUsdPer1M, 'entry output price'),
    ...(item.cacheReadUsdPer1M === undefined
      ? {}
      : { cacheReadUsdPer1M: priceValue(item.cacheReadUsdPer1M, 'entry cache read price') }),
    ...(item.cacheWriteUsdPer1M === undefined
      ? {}
      : { cacheWriteUsdPer1M: priceValue(item.cacheWriteUsdPer1M, 'entry cache write price') }),
    source: oneOf(item.source, PRICING_SOURCES, 'entry pricing source'),
  };
}

function priceValue(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw domainError(`${context} must be a non-negative finite number`);
  }
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], context: string): T {
  const parsed = stringValue(value, context, 64);
  if (!(allowed as readonly string[]).includes(parsed)) throw domainError(`${context} is invalid`);
  return parsed as T;
}

function pick(item: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (item[key] !== undefined) result[key] = item[key];
  }
  return result;
}
