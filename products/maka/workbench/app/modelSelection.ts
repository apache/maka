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
import type { ThinkingLevel } from '../../../../packages/plugin-sdk/src/generated/runtime';

export type ModelBackend = {
  connectionId: string;
  modelId: string;
  thinkingLevel: ThinkingLevel | null;
};
export type BackendIdentity = ModelBackend | null;
export type ModelChoice = {
  selection: { connectionId: string; modelId: string; revision: number };
  connectionName: string;
  label: string;
  thinkingLevels: ThinkingLevel[];
  defaultThinkingLevel: ThinkingLevel | null;
};
export type ModelDetails =
  | { kind: 'loading' }
  | { kind: 'unavailable'; message: UiText }
  | { kind: 'ready'; choice: ModelChoice };

type ModelRoute = Pick<ModelBackend, 'connectionId' | 'modelId'>;
export const sameRoute = (left: ModelRoute | null, right: ModelRoute | null): boolean =>
  left === null || right === null
    ? left === right
    : left.connectionId === right.connectionId && left.modelId === right.modelId;

export function modelCaption(backend: BackendIdentity, details: ModelDetails): string {
  if (backend === null) return tr('Choose a model');
  if (details.kind === 'ready' && sameRoute(backend, details.choice.selection))
    return details.choice.label;
  return details.kind === 'unavailable'
    ? tr('{model} · Unavailable', { model: backend.modelId })
    : backend.modelId;
}

export function effortCaption(backend: BackendIdentity, details: ModelDetails): string {
  const choice =
    details.kind === 'ready' && sameRoute(backend, details.choice.selection)
      ? details.choice
      : null;
  if (backend?.thinkingLevel == null)
    return (
      choice?.defaultThinkingLevel ??
      (choice && choice.thinkingLevels.length > 0 ? tr('Provider controlled') : '')
    );
  return choice && !choice.thinkingLevels.includes(backend.thinkingLevel)
    ? tr('{level} · Unavailable', { level: backend.thinkingLevel })
    : backend.thinkingLevel;
}

export const effectiveThinkingLevel = (
  backend: BackendIdentity,
  choice: ModelChoice,
): ThinkingLevel | null => backend?.thinkingLevel ?? choice.defaultThinkingLevel;
