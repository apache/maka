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
import type { ModelCatalogEntry } from '../model-catalog.js';
import { decodeConnectionModel } from './connection-catalog-codec.js';
import { booleanValue, domainError, exactRecord } from './domain-codec.js';

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
      'describedByMetadata',
    ],
    [
      'id',
      'canUseAsChatDefault',
      'isDefault',
      'supportsVision',
      'thinkingLevels',
      'describedByMetadata',
    ],
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
    describedByMetadata: booleanValue(item.describedByMetadata, 'entry metadata coverage'),
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

function pick(item: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (item[key] !== undefined) result[key] = item[key];
  }
  return result;
}
