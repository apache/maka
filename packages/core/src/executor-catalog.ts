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

import { isExecutorId } from './executor-id.js';
import { CATALOG_PROVIDER_TYPES, type ProviderType } from './provider-registry.js';
import { isThinkingLevel, type ThinkingLevel } from './model-thinking.js';

/** Provider-owned choices; no model Connection or external protocol identity crosses this seam. */
export interface ExecutorConfiguration {
  readonly model?: string;
}

export interface ExecutorSelection {
  readonly executorId: string;
  readonly configuration: ExecutorConfiguration;
}

export type ExecutorReadiness =
  | 'ready'
  | 'unavailable'
  | 'authentication_required'
  | 'history_only'
  | 'restorable'
  | 'restoring'
  | 'restore_failed'
  | 'history_gap';

export interface ExecutorModelChoice {
  readonly id: string;
  readonly name: string;
  readonly providerType?: ProviderType;
}

/** Presentation capability only: every variant references a real catalog model ID. */
export interface ExecutorModelGroup {
  readonly id: string;
  readonly name: string;
  readonly variants: readonly { readonly modelId: string; readonly level: ThinkingLevel }[];
}

export interface ExecutorCatalogEntry {
  readonly id: string;
  readonly displayName: string;
  readonly readiness: ExecutorReadiness;
  readonly models: readonly ExecutorModelChoice[];
  readonly modelGroups?: readonly ExecutorModelGroup[];
  readonly currentModel?: string;
  readonly supportsAttachments: boolean;
  readonly supportsModelChange: boolean;
}

export function isExecutorConfiguration(value: unknown): value is ExecutorConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) => key === 'model') &&
    (record.model === undefined ||
      (typeof record.model === 'string' &&
        record.model.length > 0 &&
        record.model.length <= 1024 &&
        !/[\0\r\n]/u.test(record.model)))
  );
}

export function normalizeCatalogEntry(
  value: ExecutorCatalogEntry,
  id: string,
): ExecutorCatalogEntry {
  if (
    !value ||
    !isExecutorId(id) ||
    value.id !== id ||
    !isCatalogText(value.displayName) ||
    ![
      'ready',
      'unavailable',
      'authentication_required',
      'history_only',
      'restorable',
      'restoring',
      'restore_failed',
      'history_gap',
    ].includes(value.readiness) ||
    !Array.isArray(value.models) ||
    value.models.length > 256 ||
    !Array.from(value.models).every(
      (model) =>
        model &&
        isExecutorConfiguration({ model: model.id }) &&
        typeof model.id === 'string' &&
        isCatalogText(model.name) &&
        (model.providerType === undefined || CATALOG_PROVIDER_TYPES.includes(model.providerType)),
    ) ||
    new Set(value.models.map((model) => model.id)).size !== value.models.length ||
    !isExecutorConfiguration({ model: value.currentModel }) ||
    typeof value.supportsAttachments !== 'boolean' ||
    typeof value.supportsModelChange !== 'boolean'
  )
    throw new TypeError('Executor catalog is invalid');
  const usedModels = new Set<string>();
  const groupIds = new Set<string>();
  if (
    value.modelGroups !== undefined &&
    (!Array.isArray(value.modelGroups) ||
      value.modelGroups.length > value.models.length ||
      !value.modelGroups.every((group) => {
        if (
          !group ||
          !isExecutorConfiguration({ model: group.id }) ||
          typeof group.id !== 'string' ||
          !isCatalogText(group.name) ||
          groupIds.has(group.id) ||
          !Array.isArray(group.variants) ||
          group.variants.length < 2 ||
          group.variants.length > 7
        )
          return false;
        groupIds.add(group.id);
        const levels = new Set<ThinkingLevel>();
        return group.variants.every((variant: ExecutorModelGroup['variants'][number]) => {
          if (
            !variant ||
            !isThinkingLevel(variant.level) ||
            levels.has(variant.level) ||
            usedModels.has(variant.modelId) ||
            !value.models.some((model) => model.id === variant.modelId)
          )
            return false;
          levels.add(variant.level);
          usedModels.add(variant.modelId);
          return true;
        });
      }))
  )
    throw new TypeError('Executor model groups are invalid');
  return Object.freeze({
    id,
    displayName: value.displayName,
    readiness: value.readiness,
    models: Object.freeze(
      value.models.map(({ id, name, providerType }) =>
        Object.freeze({
          id,
          name,
          ...(providerType !== undefined ? { providerType } : {}),
        }),
      ),
    ),
    ...(value.modelGroups !== undefined
      ? {
          modelGroups: Object.freeze(
            value.modelGroups.map((group) =>
              Object.freeze({
                id: group.id,
                name: group.name,
                variants: Object.freeze(
                  group.variants.map(({ modelId, level }: ExecutorModelGroup['variants'][number]) =>
                    Object.freeze({ modelId, level }),
                  ),
                ),
              }),
            ),
          ),
        }
      : {}),
    ...(value.currentModel !== undefined ? { currentModel: value.currentModel } : {}),
    supportsAttachments: value.supportsAttachments,
    supportsModelChange: value.supportsModelChange,
  });
}

function isCatalogText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 8_192 && !/[\0\r]/u.test(value);
}
