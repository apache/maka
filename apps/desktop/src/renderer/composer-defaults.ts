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

/**
 * Global "last selection" defaults for the composer's folder / permission
 * mode / model chips. Survives reloads so a freshly created task inherits the
 * most recent pick instead of falling back to factory defaults.
 *
 * Keyed with a `v1` suffix to allow schema migration later.
 */

import { safeLocalStorageGet, safeLocalStorageSet } from './browser-storage';

const STORAGE_KEY = 'maka-composer-defaults-v1';

export interface ComposerDefaults {
  model: { llmConnectionSlug: string; model: string } | null;
}

const EMPTY: ComposerDefaults = {
  model: null,
};

function isString(value: unknown): value is string {
  return typeof value === 'string';
}
function isModel(value: unknown): value is { llmConnectionSlug: string; model: string } {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return isString(record.llmConnectionSlug) && isString(record.model);
}

function parse(raw: string | null): ComposerDefaults | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      model: isModel(parsed.model) ? parsed.model : null,
    };
  } catch {
    // Corrupt JSON — treat as absent so callers fall back to defaults.
    return null;
  }
}

/** Read the persisted defaults. Returns `null` when storage is empty/invalid. */
export function loadComposerDefaults(): ComposerDefaults | null {
  return parse(safeLocalStorageGet(STORAGE_KEY));
}

/**
 * Merge-write: reads the current persisted blob, overlays the provided partial,
 * and writes back. Fields set to `null` are cleared. Keeps the on-disk shape
 * stable even when only one selection changes.
 */
export function saveComposerDefaults(patch: Partial<ComposerDefaults>): void {
  const current = loadComposerDefaults() ?? EMPTY;
  const next: ComposerDefaults = {
    model: patch.model !== undefined ? patch.model : current.model,
  };
  safeLocalStorageSet(STORAGE_KEY, JSON.stringify(next));
}
