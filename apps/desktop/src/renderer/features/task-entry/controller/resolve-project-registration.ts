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

import type { ProjectRecord } from '@maka/core/project';
import type { TaskEntryProjectMutationResult } from '../ports.js';

export type ProjectRegistrationResult =
  | { readonly ok: true; readonly project: ProjectRecord; readonly restored?: true }
  | Exclude<TaskEntryProjectMutationResult, { readonly ok: true }>;

/** Resolves registration without deciding how the caller uses the Project. */
export async function resolveProjectRegistration(input: {
  register(): Promise<TaskEntryProjectMutationResult>;
  confirm(onConfirm: () => Promise<void>): Promise<boolean>;
  restore(projectId: string): Promise<TaskEntryProjectMutationResult>;
  isCurrent(): boolean;
}): Promise<ProjectRegistrationResult | undefined> {
  if (!input.isCurrent()) return;
  const result = await input.register();
  if (!input.isCurrent()) return;
  if (result.ok || result.reason !== 'archived') return result;
  let restored: TaskEntryProjectMutationResult | undefined;
  const confirmed = await input.confirm(async () => {
    if (!input.isCurrent()) return;
    restored = await input.restore(result.projectId);
  });
  if (!input.isCurrent()) return;
  if (!confirmed) return { ok: false, reason: 'cancelled' };
  if (!restored) return;
  if (!restored.ok && restored.reason === 'archived') {
    throw new Error('Project remains archived after restore');
  }
  return restored.ok ? { ...restored, restored: true } : restored;
}
