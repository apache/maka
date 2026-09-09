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

import type { ThinkingLevel } from '@maka/core/model-thinking';

export type SessionModelTarget = {
  llmConnectionId: string;
  llmConnectionSlug: string;
  model: string;
};

export type SessionModelConfigurationIntent = {
  modelTarget: SessionModelTarget;
  thinkingLevel: ThinkingLevel | null;
  changedSetting: 'model' | 'thinking';
};

export function equalSessionModelConfigurationIntent(
  left: SessionModelConfigurationIntent,
  right: SessionModelConfigurationIntent,
): boolean {
  return left.modelTarget.llmConnectionId === right.modelTarget.llmConnectionId &&
    left.modelTarget.llmConnectionSlug === right.modelTarget.llmConnectionSlug &&
    left.modelTarget.model === right.modelTarget.model &&
    left.thinkingLevel === right.thinkingLevel;
}

export function modelConfigurationIntentForModel(
  modelTarget: SessionModelTarget,
): SessionModelConfigurationIntent {
  return { modelTarget, thinkingLevel: null, changedSetting: 'model' };
}

export function modelConfigurationIntentForThinking(
  currentModelTarget: SessionModelTarget | undefined,
  pending: SessionModelConfigurationIntent | undefined,
  thinkingLevel: ThinkingLevel | null,
): SessionModelConfigurationIntent | undefined {
  const modelTarget = pending?.modelTarget ?? currentModelTarget;
  return modelTarget
    ? { modelTarget, thinkingLevel, changedSetting: 'thinking' }
    : undefined;
}
