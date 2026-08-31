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
import type {
  KnownModelCapabilities,
  ModelCatalogEntry,
  ModelCatalogLifecycle,
  ModelCatalogPricing,
  ModelCatalogProvenanceSources,
  ModelCatalogUserChoiceSource,
} from '../model-catalog.js';
import { decodeConnectionModel, decodeProviderType } from './connection-catalog-codec.js';
import {
  booleanValue,
  domainError,
  exactRecord,
  integerValue,
  nonEmptyStringValue,
  stringValue,
} from './domain-codec.js';

const ENTRY_SOURCES = ['provider_api', 'static_catalog', 'unknown'] as const;
const UNAVAILABLE_REASONS = [
  'none',
  'not_in_live_list',
  'unsupported_for_chat',
  'provider_removed',
  'auth',
  'stale',
] as const;
const AVAILABILITIES = ['available', 'warning', 'blocked'] as const;
const LIFECYCLES = ['active', 'beta', 'alpha', 'deprecated', 'retired', 'unknown'] as const;
const USER_CHOICE_SOURCES = [
  'connection_default',
  'saved_model',
  'session_model',
  'daily_review_model',
] as const;
const CAPABILITY_KEYS = [
  'chat',
  'vision',
  'reasoning',
  'functionCalling',
  'parallelToolCalls',
  'imageGeneration',
  'webSearch',
] as const satisfies readonly (keyof KnownModelCapabilities)[];
const MODEL_SOURCES = ['fetched', 'fallback'] as const;
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
      'providerType',
      'connectionSlug',
      'source',
      'unavailableReason',
      'availability',
      'canUseAsChatDefault',
      'isDefault',
      'capabilities',
      'thinkingLevels',
      'lifecycle',
      'docsUrl',
      'contextWindow',
      'inputLimit',
      'maxOutputTokens',
      'knowledgeCutoff',
      'structuredOutput',
      'lastUpdated',
      'modalities',
      'pricing',
      'provenance',
    ],
    [
      'id',
      'providerType',
      'source',
      'unavailableReason',
      'availability',
      'canUseAsChatDefault',
      'isDefault',
      'capabilities',
      'thinkingLevels',
      'lifecycle',
      'provenance',
    ],
  );
  // The fields an entry shares with a stored model row keep one decoder, so a
  // bound that moves moves for both. `decodeConnectionModel` rejects unknown
  // fields, so it is handed exactly the subset it owns.
  const shared = decodeConnectionModel({
    id: item.id,
    ...pick(item, [
      'displayName',
      'description',
      'contextWindow',
      'inputLimit',
      'maxOutputTokens',
      'knowledgeCutoff',
      'structuredOutput',
      'lastUpdated',
      'modalities',
    ]),
  });
  return {
    ...shared,
    providerType: decodeProviderType(item.providerType),
    ...(item.connectionSlug === undefined
      ? {}
      : { connectionSlug: nonEmptyStringValue(item.connectionSlug, 'entry connection slug', 128) }),
    source: oneOf(item.source, ENTRY_SOURCES, 'entry source'),
    unavailableReason: oneOf(
      item.unavailableReason,
      UNAVAILABLE_REASONS,
      'entry unavailable reason',
    ),
    availability: oneOf(item.availability, AVAILABILITIES, 'entry availability'),
    canUseAsChatDefault: booleanValue(item.canUseAsChatDefault, 'entry chat default eligibility'),
    isDefault: booleanValue(item.isDefault, 'entry default flag'),
    capabilities: decodeKnownCapabilities(item.capabilities),
    thinkingLevels: decodeThinkingLevels(item.thinkingLevels),
    lifecycle: oneOf<ModelCatalogLifecycle>(item.lifecycle, LIFECYCLES, 'entry lifecycle'),
    ...(item.docsUrl === undefined
      ? {}
      : { docsUrl: nonEmptyStringValue(item.docsUrl, 'entry docs URL', 2048) }),
    ...(item.pricing === undefined ? {} : { pricing: decodePricing(item.pricing) }),
    provenance: decodeProvenance(item.provenance),
  };
}

function decodeKnownCapabilities(value: unknown): KnownModelCapabilities {
  const raw = exactRecord(value, 'entry capabilities', CAPABILITY_KEYS, []);
  const capabilities: Record<string, true> = {};
  for (const key of Object.keys(raw)) {
    if (raw[key] !== true) throw domainError(`entry capability ${key} must be true when present`);
    capabilities[key] = true;
  }
  return capabilities;
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

function decodeProvenance(value: unknown): ModelCatalogEntry['provenance'] {
  const item = exactRecord(
    value,
    'entry provenance',
    ['modelSource', 'modelsFetchedAt', 'pricingModelKey', 'userChoice', 'sources'],
    [],
  );
  if (item.userChoice !== undefined && item.userChoice !== true) {
    throw domainError('entry provenance user choice must be true when present');
  }
  return {
    ...(item.modelSource === undefined
      ? {}
      : { modelSource: oneOf(item.modelSource, MODEL_SOURCES, 'entry model source') }),
    ...(item.modelsFetchedAt === undefined
      ? {}
      : {
          modelsFetchedAt: integerValue(
            item.modelsFetchedAt,
            'entry models fetched at',
            0,
            Number.MAX_SAFE_INTEGER,
          ),
        }),
    ...(item.pricingModelKey === undefined
      ? {}
      : {
          pricingModelKey: nonEmptyStringValue(item.pricingModelKey, 'entry pricing key', 512),
        }),
    ...(item.userChoice === undefined ? {} : { userChoice: true as const }),
    ...(item.sources === undefined ? {} : { sources: decodeProvenanceSources(item.sources) }),
  };
}

function decodeProvenanceSources(value: unknown): ModelCatalogProvenanceSources {
  const item = exactRecord(
    value,
    'entry provenance sources',
    ['providerInventory', 'staticCatalog', 'userChoice'],
    [],
  );
  for (const key of ['providerInventory', 'staticCatalog'] as const) {
    if (item[key] !== undefined && item[key] !== true) {
      throw domainError(`entry provenance ${key} must be true when present`);
    }
  }
  let userChoice: ModelCatalogUserChoiceSource[] | undefined;
  if (item.userChoice !== undefined) {
    if (!Array.isArray(item.userChoice) || item.userChoice.length === 0) {
      throw domainError('entry provenance user choices must be a non-empty array');
    }
    userChoice = item.userChoice.map((source) =>
      oneOf(source, USER_CHOICE_SOURCES, 'entry provenance user choice'),
    );
    if (new Set(userChoice).size !== userChoice.length) {
      throw domainError('entry provenance user choices must be unique');
    }
  }
  return {
    ...(item.providerInventory === undefined ? {} : { providerInventory: true as const }),
    ...(item.staticCatalog === undefined ? {} : { staticCatalog: true as const }),
    ...(userChoice === undefined ? {} : { userChoice }),
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
