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
  AgentWorkspace,
  SkillLibraryRead,
} from '../../../../../../packages/plugin-sdk/src/generated/runtime';
import type { SettingsRpc } from './rpc';

export async function readSkills(
  rpc: SettingsRpc,
  workspace: AgentWorkspace | null,
  query: string,
) {
  const first = await rpc.query('skillLibrary', 'list', { workspace, query, cursor: null });
  if (first.kind !== 'page') throw new Error(first.kind);
  const entries = [...first.entries];
  let cursor = first.after;
  while (cursor != null) {
    const page = await rpc.query('skillLibrary', 'list', { workspace, query, cursor });
    if (page.kind !== 'page') throw new Error(page.kind);
    entries.push(...page.entries);
    cursor = page.after;
  }
  return { ...first, entries };
}

export async function readSkill(rpc: SettingsRpc, input: Omit<SkillLibraryRead, 'offset'>) {
  const first = await rpc.query('skillLibrary', 'read', { ...input, offset: 0 });
  if (first.kind !== 'page') throw new Error(first.kind);
  let text = first.text;
  let offset = first.after;
  while (offset != null) {
    const page = await rpc.query('skillLibrary', 'read', { ...input, offset });
    if (page.kind !== 'page') throw new Error(page.kind);
    text += page.text;
    offset = page.after;
  }
  return { ...first, text };
}

export async function manageSkill(
  rpc: SettingsRpc,
  method: 'update' | 'delete',
  workspace: AgentWorkspace | null,
  reference: string,
) {
  const result = await rpc.mutate('skillLibrary', method, { workspace, reference });
  if (result.kind !== 'applied') throw new Error(result.reason);
}
