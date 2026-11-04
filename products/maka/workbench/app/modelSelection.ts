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

import { tr } from './locale';
import type { UiText } from './text';
import type {
  AgentBackendPreference,
  AgentModelChoice,
  ThinkingLevel,
} from '../../../../packages/plugin-sdk/src/generated/runtime';

export type ModelBackend = AgentBackendPreference;
export type BackendIdentity = ModelBackend | null;
export type ModelChoice = AgentModelChoice;
export type ModelDetails =
  | { kind: 'loading' }
  | { kind: 'unavailable'; message: UiText }
  | { kind: 'ready'; choice: ModelChoice };

export const routeKey = (backend: ModelBackend): string =>
  backend.kind === 'model'
    ? JSON.stringify(['model', backend.connectionId, backend.modelId])
    : JSON.stringify([
        'executor',
        backend.selection.executor,
        backend.selection.settings.runtime ?? null,
        backend.selection.settings.model ?? null,
      ]);

export const sameRoute = (left: BackendIdentity, right: BackendIdentity): boolean =>
  left === null || right === null ? left === right : routeKey(left) === routeKey(right);

export const thinkingLevel = (backend: BackendIdentity): string | null =>
  (backend?.kind === 'model' ? backend.thinkingLevel : backend?.selection.settings.thinkingLevel) ??
  null;

export const sameBackend = (left: BackendIdentity, right: BackendIdentity): boolean =>
  sameRoute(left, right) && thinkingLevel(left) === thinkingLevel(right);

export const backendName = (backend: ModelBackend): string =>
  backend.kind === 'model'
    ? backend.modelId
    : (backend.selection.settings.model ?? backend.selection.executor);

function nativeThinkingLevel(level: string | null): ThinkingLevel | null {
  switch (level) {
    case null:
    case 'off':
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
    case 'ultra':
      return level;
    default:
      throw new Error(`Unsupported native thinking level: ${level}`);
  }
}

export function withThinkingLevel(backend: ModelBackend, level: string | null): ModelBackend {
  return backend.kind === 'model'
    ? { ...backend, thinkingLevel: nativeThinkingLevel(level) }
    : {
        ...backend,
        selection: {
          ...backend.selection,
          settings: { ...backend.selection.settings, thinkingLevel: level },
        },
      };
}

export function modelCaption(backend: BackendIdentity, details: ModelDetails): string {
  if (backend === null) return tr('Choose a model');
  if (details.kind === 'ready' && sameRoute(backend, details.choice.selection))
    return `${details.choice.label} · ${details.choice.sourceName}`;
  return details.kind === 'unavailable'
    ? tr('{model} · Unavailable', { model: backendName(backend) })
    : backendName(backend);
}

export function effortCaption(backend: BackendIdentity, details: ModelDetails): string {
  const choice =
    details.kind === 'ready' && sameRoute(backend, details.choice.selection)
      ? details.choice
      : null;
  const level = thinkingLevel(backend);
  if (level === null) return choice?.defaultThinkingLevel ?? '';
  return choice && !choice.thinkingLevels.includes(level)
    ? tr('{level} · Unavailable', { level })
    : level;
}

export const effectiveThinkingLevel = (
  backend: BackendIdentity,
  choice: ModelChoice,
): string | null => thinkingLevel(backend) ?? choice.defaultThinkingLevel ?? null;
