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

import {
  DEFAULT_TOOL_MODE_PREFERENCE,
  isToolModePreference,
  type ToolModePreference,
} from '@maka/core/tool-mode';

/**
 * Sentinel for "no preference" — the Selector needs a value, absence is not
 * one. Mirrors the thinking-level picker's `FOLLOW_MODEL_DEFAULT` pattern.
 */
export const AUTO_TOOL_MODE_VALUE = '__auto__';

/**
 * Static Code Mode capability of the Desktop Runtime Host composition,
 * evaluated at Settings time. The host composes the ai-sdk backend, whose
 * Code Mode `exec` tool ships unconditionally, so every backend this build
 * can run supports Code Mode. A future host composition that cannot execute
 * CodeMode flips this signal (or passes its own evaluation into the card),
 * and the selector renders its explicit unavailable state instead of ever
 * silently downgrading a selected `code_mode`.
 */
export const DESKTOP_CODE_MODE_AVAILABLE = true;

export interface ToolModePreferenceCopy {
  readonly auto: string;
  readonly direct: string;
  readonly codeMode: string;
  /** Shown on/next to the disabled option when Code Mode is unavailable. */
  readonly codeModeUnavailable: string;
}

export interface ToolModePreferenceOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

/**
 * The three-value closed preference as selector options. When the active
 * composition cannot execute CodeMode, that option renders
 * disabled-with-reason; an already-persisted `code_mode` selection is left
 * visible and intact — never rewritten behind the user's back.
 */
export function projectToolModePreferenceOptions(
  copy: ToolModePreferenceCopy,
  codeModeAvailable: boolean,
): ToolModePreferenceOption[] {
  return [
    { value: AUTO_TOOL_MODE_VALUE, label: copy.auto },
    { value: 'direct', label: copy.direct },
    codeModeAvailable
      ? { value: 'code_mode', label: copy.codeMode }
      : {
          value: 'code_mode',
          label: `${copy.codeMode} · ${copy.codeModeUnavailable}`,
          disabled: true,
        },
  ];
}

/**
 * The persisted preference as displayed value. The Runtime Host stores an
 * explicit override or omits the field entirely (`auto`), and anything
 * unrecognized reads as `auto` too — a garbage value must never surface as a
 * mode the picker does not recognize.
 */
export function readToolModePreferenceValue(value: unknown): ToolModePreference {
  return isToolModePreference(value) ? value : DEFAULT_TOOL_MODE_PREFERENCE;
}

/** Map a selector value back to the persisted patch value (`auto` persists literally). */
export function toolModePreferenceFromValue(value: string): ToolModePreference | undefined {
  if (value === AUTO_TOOL_MODE_VALUE) return DEFAULT_TOOL_MODE_PREFERENCE;
  return isToolModePreference(value) ? value : undefined;
}
