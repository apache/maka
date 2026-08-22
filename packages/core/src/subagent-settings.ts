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

import { isThinkingLevel, type ThinkingLevel } from './model-thinking.js';

export const SUBAGENT_PROFILES = ['local_read', 'web_research', 'implementation'] as const;
export type SubagentProfile = (typeof SUBAGENT_PROFILES)[number];

export const MAX_SUBAGENT_PRESETS = 64;
export const SUBAGENT_PRESET_ID_MAX_CHARS = 128;
// Normalization DROPS a preset whose name is too long and TRUNCATES a
// description that is, so any editor writing these fields has to enforce the
// same numbers — silently losing the preset the user just saved is the
// alternative. Exported for exactly that.
export const SUBAGENT_PRESET_NAME_MAX_CHARS = 128;
export const SUBAGENT_PRESET_DESCRIPTION_MAX_CHARS = 1_000;
const SAFE_SUBAGENT_PRESET_ID = /^[A-Za-z0-9._:-]+$/;

/** User-approved model route for one catalog subagent capability. */
export interface SubagentPreset {
  id: string;
  name: string;
  description: string;
  profile: SubagentProfile;
  connectionSlug: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
  enabled: boolean;
}

export interface SubagentSettings {
  presets: SubagentPreset[];
}

export function isSubagentProfile(value: unknown): value is SubagentProfile {
  return typeof value === 'string' && (SUBAGENT_PROFILES as readonly string[]).includes(value);
}

export function isSafeSubagentPresetId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= SUBAGENT_PRESET_ID_MAX_CHARS &&
    SAFE_SUBAGENT_PRESET_ID.test(value)
  );
}

export function normalizeSubagentSettings(input: unknown): SubagentSettings {
  if (
    !input ||
    typeof input !== 'object' ||
    !Array.isArray((input as { presets?: unknown }).presets)
  ) {
    return { presets: [] };
  }
  const presets: SubagentPreset[] = [];
  const seen = new Set<string>();
  for (const candidate of (input as { presets: unknown[] }).presets) {
    if (presets.length >= MAX_SUBAGENT_PRESETS) break;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const value = candidate as Record<string, unknown>;
    if (
      !isSafeSubagentPresetId(value.id) ||
      seen.has(value.id) ||
      !isSubagentProfile(value.profile) ||
      typeof value.name !== 'string' ||
      value.name.trim().length < 1 ||
      value.name.trim().length > SUBAGENT_PRESET_NAME_MAX_CHARS ||
      typeof value.connectionSlug !== 'string' ||
      value.connectionSlug.trim().length < 1 ||
      value.connectionSlug.trim().length > 128 ||
      typeof value.model !== 'string' ||
      value.model.trim().length < 1 ||
      value.model.trim().length > 512 ||
      (value.enabled !== true && value.enabled !== false) ||
      (value.thinkingLevel !== undefined && !isThinkingLevel(value.thinkingLevel))
    ) {
      continue;
    }
    const id = value.id;
    seen.add(id);
    presets.push({
      id,
      name: value.name.trim(),
      description:
        typeof value.description === 'string'
          ? value.description.trim().slice(0, SUBAGENT_PRESET_DESCRIPTION_MAX_CHARS)
          : '',
      profile: value.profile,
      connectionSlug: value.connectionSlug.trim(),
      model: value.model.trim(),
      ...(value.thinkingLevel !== undefined ? { thinkingLevel: value.thinkingLevel } : {}),
      enabled: value.enabled,
    });
  }
  return { presets };
}
