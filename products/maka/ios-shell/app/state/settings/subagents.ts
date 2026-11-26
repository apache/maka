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

import type { ServiceMethods } from '../../../../../../packages/plugin-sdk/src/generated/methods';
import type {
  ModelSelection,
  ThinkingLevel,
} from '../../../../../../packages/plugin-sdk/src/generated/runtime';
import type { SettingsRpc } from './rpc';

export type Preset = NonNullable<ServiceMethods['agent']['preset']['output']>['preset'];
export type PresetDraft = {
  name: string;
  description: string;
  instruction: string;
  model: ModelSelection;
  thinkingLevel: ThinkingLevel | null;
  enabled: boolean;
};

export async function savePreset(rpc: SettingsRpc, draft: PresetDraft, original: Preset | null) {
  const result = original
    ? await rpc.mutate('agent', 'updatePreset', {
        id: original.id,
        expectedRevision: original.revision,
        name: draft.name,
        description: draft.description,
        instruction: draft.instruction,
        model: draft.model,
        enabled: draft.enabled,
        thinkingLevel: draft.thinkingLevel
          ? { kind: 'set', value: draft.thinkingLevel }
          : { kind: 'default' },
      })
    : await rpc.mutate('agent', 'createPreset', draft);
  if (result.kind !== 'saved')
    throw new Error('reason' in result ? String(result.reason) : result.kind);
}

export async function deletePreset(rpc: SettingsRpc, original: Preset) {
  const result = await rpc.mutate('agent', 'deletePreset', {
    id: original.id,
    expectedRevision: original.revision,
  });
  if (result.kind !== 'deleted') throw new Error(result.kind);
}
