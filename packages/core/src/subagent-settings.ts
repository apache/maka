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
export const AD_HOC_SUBAGENT_ID = 'temporary-bounded' as const;
export const AD_HOC_SUBAGENT_NAME = 'Temporary bounded' as const;
export const AD_HOC_SUBAGENT_DESCRIPTION =
  'One-off task role inside the user-approved maximum authority envelope.' as const;
export const AD_HOC_ROLE_NAME_MAX_CHARS = 128;
export const AD_HOC_ROLE_PURPOSE_MAX_CHARS = 512;
export const AD_HOC_ROLE_INSTRUCTIONS_MAX_CHARS = 4_000;
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
  /** Optional, disabled-by-absence policy for one-off foreground roles. */
  adHoc?: AdHocSubagentPolicy;
}

/**
 * Host-selected ceiling for the synthetic temporary-bounded child route.
 * Model input can describe the task role, but cannot select any of these
 * authority-bearing fields.
 */
export interface AdHocSubagentPolicy {
  enabled: boolean;
  maxProfile: SubagentProfile;
  connectionSlug: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
}

/** Task-scoped role text accepted only for the synthetic ad-hoc route. */
export interface AdHocSubagentRole {
  name?: string;
  purpose?: string;
  instructions?: string;
}

export function normalizeAdHocSubagentRole(input: unknown): AdHocSubagentRole | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  const fields = ['name', 'purpose', 'instructions'] as const;
  if (Object.keys(value).some((key) => !fields.includes(key as (typeof fields)[number]))) {
    return undefined;
  }
  for (const field of fields) {
    if (value[field] !== undefined && typeof value[field] !== 'string') return undefined;
  }
  const name = typeof value.name === 'string' ? value.name.trim() : undefined;
  const purpose = typeof value.purpose === 'string' ? value.purpose.trim() : undefined;
  const instructions =
    typeof value.instructions === 'string' ? value.instructions.trim() : undefined;
  if ([name, purpose, instructions].some((text) => text !== undefined && hasUnsafeRoleText(text))) {
    return undefined;
  }
  if (name !== undefined && (name.length < 1 || name.length > AD_HOC_ROLE_NAME_MAX_CHARS)) {
    return undefined;
  }
  if (
    purpose !== undefined &&
    (purpose.length < 1 || purpose.length > AD_HOC_ROLE_PURPOSE_MAX_CHARS)
  ) {
    return undefined;
  }
  if (
    instructions !== undefined &&
    (instructions.length < 1 || instructions.length > AD_HOC_ROLE_INSTRUCTIONS_MAX_CHARS)
  ) {
    return undefined;
  }
  if (name === undefined && purpose === undefined && instructions === undefined) return undefined;
  return {
    ...(name !== undefined ? { name } : {}),
    ...(purpose !== undefined ? { purpose } : {}),
    ...(instructions !== undefined ? { instructions } : {}),
  };
}

function hasUnsafeRoleText(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value);
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
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { presets: [] };
  const rawPresets = (input as { presets?: unknown }).presets;
  const presets: SubagentPreset[] = [];
  const seen = new Set<string>();
  for (const candidate of Array.isArray(rawPresets) ? rawPresets : []) {
    if (presets.length >= MAX_SUBAGENT_PRESETS) break;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const value = candidate as Record<string, unknown>;
    if (
      !isSafeSubagentPresetId(value.id) ||
      value.id === AD_HOC_SUBAGENT_ID ||
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
  const rawAdHoc = (input as { adHoc?: unknown }).adHoc;
  const adHoc = normalizeAdHocSubagentPolicy(rawAdHoc);
  return adHoc ? { presets, adHoc } : { presets };
}

function normalizeAdHocSubagentPolicy(input: unknown): AdHocSubagentPolicy | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) => !['enabled', 'maxProfile', 'connectionSlug', 'model', 'thinkingLevel'].includes(key),
    )
  ) {
    return undefined;
  }
  if (
    (value.enabled !== true && value.enabled !== false) ||
    !isSubagentProfile(value.maxProfile) ||
    typeof value.connectionSlug !== 'string' ||
    value.connectionSlug.trim().length < 1 ||
    value.connectionSlug.trim().length > 128 ||
    typeof value.model !== 'string' ||
    value.model.trim().length < 1 ||
    value.model.trim().length > 512 ||
    (value.thinkingLevel !== undefined && !isThinkingLevel(value.thinkingLevel))
  ) {
    return undefined;
  }
  return {
    enabled: value.enabled,
    maxProfile: value.maxProfile,
    connectionSlug: value.connectionSlug.trim(),
    model: value.model.trim(),
    ...(value.thinkingLevel !== undefined ? { thinkingLevel: value.thinkingLevel } : {}),
  };
}
