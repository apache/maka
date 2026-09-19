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

import type { ModelInfo } from '@maka/core/llm-connections';
import { isThinkingLevel } from '@maka/core/model-thinking';
import { record } from './protocol.js';

/** Only routes advertised to this account become selectable. No offline model roster. */
export function parseTraeCatalog(payload: unknown, publicFunction?: string): ModelInfo[] {
  const root = record(payload);
  const rows = root?.config_info_list;
  if (!Array.isArray(rows)) throw new Error('Trae returned an invalid model catalog');
  const models = new Map<string, ModelInfo>();
  for (const value of rows) {
    const row = record(value);
    if (
      !row ||
      (publicFunction
        ? row.usage !== undefined && row.usage !== 'chat_completion'
        : row.usage !== 'chat_completion') ||
      (publicFunction ? row.config_switch === false : row.config_switch !== true) ||
      row.is_invisible_to_user === true
    )
      continue;
    const configName = nonEmpty(row.config_name);
    const display = record(row.display_config) ?? {};
    if (!configName || display.is_invisible_to_user === true) continue;
    const hot = record(display.hot_info)?.hot;
    const loadPercent =
      typeof hot === 'number' && Number.isFinite(hot) ? Math.max(0, Math.round(hot)) : undefined;
    const details = Array.isArray(row.model_detail_list)
      ? row.model_detail_list.map(record).filter((d) => d && nonEmpty(d.model_name))
      : [];
    const standard =
      details.find((d) => String(d?.model_name).endsWith('__dev')) ??
      details.find((d) => String(d?.model_name).endsWith('__v2')) ??
      details.find((d) => !String(d?.model_name).endsWith('__max'));
    const max =
      publicFunction || display.max_mode === false
        ? undefined
        : details.find((d) => String(d?.model_name).endsWith('__max'));
    for (const [mode, detail] of [
      ['standard', standard],
      ['max', max],
    ] as const) {
      if (!detail) continue;
      const modelName = nonEmpty(detail.model_name)!;
      const id = `${encodeURIComponent(configName)}:${mode}`;
      const reasoning = display.model_capability === 'reasoning_model';
      let extra: Record<string, unknown> | undefined;
      try {
        extra = record(JSON.parse(String(detail.model_extra_config ?? '{}')));
      } catch {
        /* Missing options leave the upstream default intact. */
      }
      const reasoningEfforts =
        reasoning && Array.isArray(extra?.reasoning_effort_options)
          ? [
              ...new Set(
                extra.reasoning_effort_options
                  .filter((x): x is string => typeof x === 'string')
                  .map((x) => x.toLowerCase().trim())
                  .filter((x) => isThinkingLevel(x) && x !== 'off'),
              ),
            ]
          : [];
      if (
        !publicFunction &&
        reasoning &&
        row.config_source !== 2 &&
        row.config_source !== 3 &&
        display.is_custom_model !== true &&
        configName.toLowerCase() === 'gpt-5.6-sol' &&
        modelName.replace(/__(dev|v2|max)$/, '').toLowerCase() === 'gpt-5.6-sol' &&
        !reasoningEfforts.includes('ultra')
      )
        reasoningEfforts.push('ultra');
      const inputLimit =
        positive(detail.prompt_max_tokens) ?? positive(record(row.context_window_tokens)?.dev);
      const maxOutputTokens = positive(detail.max_tokens);
      models.set(id, {
        id,
        displayName: `${nonEmpty(display.display_name) ?? configName} · ${mode === 'max' ? 'Max' : 'Standard'}`,
        ...(inputLimit ? { inputLimit } : {}),
        ...(inputLimit && maxOutputTokens ? { contextWindow: inputLimit + maxOutputTokens } : {}),
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
        capabilities: { reasoning, vision: display.multimodal === true },
        trae: {
          ...(publicFunction ? { function: publicFunction } : {}),
          configName,
          modelName,
          mode,
          reasoningEfforts,
          toolResponseImages: display.tool_response_multimodal === true,
          ...(loadPercent === undefined ? {} : { loadPercent }),
        },
      });
    }
  }
  return [...models.values()];
}
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= 400
    ? value.trim()
    : undefined;
}
function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
