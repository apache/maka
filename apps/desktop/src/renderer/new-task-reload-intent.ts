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

const NEW_TASK_RELOAD_INTENT_KEY = 'maka-new-task-reload-intent-v1';
export const UNRESOLVED_NEW_TASK_DRAFT_KEY = 'new-task:unresolved';

type SessionStorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface NewTaskReloadIntent {
  draft: string;
  draftKey?: string;
}

function rendererSessionStorage(): SessionStorageLike | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * A renderer-reload lease for the explicit empty new-task surface.
 * sessionStorage survives HMR/navigation reloads but not a new application
 * window, so ordinary cold-start history restoration remains unchanged.
 */
export function hasNewTaskReloadIntent(
  storage: SessionStorageLike | undefined = rendererSessionStorage(),
): boolean {
  try {
    return readNewTaskReloadIntent(storage) !== undefined;
  } catch {
    return false;
  }
}

export function markNewTaskReloadIntent(
  storage: SessionStorageLike | undefined = rendererSessionStorage(),
): void {
  try {
    const existing = readNewTaskReloadIntent(storage);
    storage?.setItem(
      NEW_TASK_RELOAD_INTENT_KEY,
      JSON.stringify({
        draft: existing?.draft ?? '',
        ...(existing?.draftKey ? { draftKey: existing.draftKey } : {}),
      } satisfies NewTaskReloadIntent),
    );
  } catch {
    // Restricted renderer contexts may not expose web storage.
  }
}

export function readNewTaskReloadIntent(
  storage: SessionStorageLike | undefined = rendererSessionStorage(),
): NewTaskReloadIntent | undefined {
  try {
    const raw = storage?.getItem(NEW_TASK_RELOAD_INTENT_KEY);
    if (!raw) return undefined;
    // The original marker shipped as the literal `1`. Keep reloads made by
    // that version fail-soft while treating the marker as surface state only.
    if (raw === '1') return { draft: '' };
    const parsed = JSON.parse(raw) as Partial<NewTaskReloadIntent>;
    if (typeof parsed.draft !== 'string') return undefined;
    return {
      draft: parsed.draft,
      ...(typeof parsed.draftKey === 'string' ? { draftKey: parsed.draftKey } : {}),
    };
  } catch {
    return undefined;
  }
}

export function writeNewTaskReloadDraft(
  draftKey: string,
  draft: string,
  storage: SessionStorageLike | undefined = rendererSessionStorage(),
): void {
  try {
    const intent = readNewTaskReloadIntent(storage);
    if (!intent) return;
    const persistedKey = draftKey === UNRESOLVED_NEW_TASK_DRAFT_KEY
      ? intent.draftKey ?? draftKey
      : draftKey;
    storage?.setItem(
      NEW_TASK_RELOAD_INTENT_KEY,
      JSON.stringify({ draft, draftKey: persistedKey }),
    );
  } catch {
    // Restricted renderer contexts may not expose web storage.
  }
}

export function readNewTaskReloadDraft(
  draftKey: string,
  storage: SessionStorageLike | undefined = rendererSessionStorage(),
): string | undefined {
  const intent = readNewTaskReloadIntent(storage);
  if (!intent) return undefined;
  return draftKey === UNRESOLVED_NEW_TASK_DRAFT_KEY || intent.draftKey === draftKey
    ? intent.draft
    : undefined;
}

export function clearNewTaskReloadIntent(
  storage: SessionStorageLike | undefined = rendererSessionStorage(),
): void {
  try {
    storage?.removeItem(NEW_TASK_RELOAD_INTENT_KEY);
  } catch {
    // Restricted renderer contexts may not expose web storage.
  }
}
