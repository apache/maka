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

import { tr } from '../../locale';
import type {
  SettingsAssistantPreferences,
  SettingsPreferencesMutation,
} from '../../../../../../packages/plugin-sdk/src/generated/runtime';
import type { SettingsRpc } from './rpc';

export async function readGeneral(rpc: SettingsRpc) {
  const [preferences, instructions] = await Promise.all([
    rpc.query('settings', 'assistantPreferences', {}),
    rpc.query('agent', 'globalInstructions', {}),
  ]);
  return { preferences, instructions };
}

export async function saveInstructions(
  rpc: SettingsRpc,
  basis: Extract<Awaited<ReturnType<typeof readGeneral>>['instructions'], { kind: 'available' }>,
  content: string,
) {
  const result = await rpc.mutate('agent', 'updateGlobalInstructions', {
    source: basis.source,
    revision: basis.revision,
    content,
  });
  if (result.kind !== 'saved')
    throw new Error(tr('Could not read or update settings.'), { cause: result.kind });
}

export async function savePreference(
  rpc: SettingsRpc,
  basis: SettingsAssistantPreferences,
  mutation: SettingsPreferencesMutation,
) {
  const result = await rpc.mutate('settings', 'updateAssistantPreferences', {
    expectedRevision: basis.revision,
    mutation,
  });
  if (result.kind !== 'committed')
    throw new Error(tr('Could not read or update settings.'), { cause: result.kind });
  return rpc.query('settings', 'assistantPreferences', {});
}
