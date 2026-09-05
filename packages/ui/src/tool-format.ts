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

import type { UiLocale } from './locale-helpers.js';
import { redactSecrets } from './redact.js';
import { getToolActivityCopy } from './tool-activity/copy.js';

/** Locale-aware display name for the tool-discovery connector. */
export function loadToolDisplayName(locale: UiLocale): string {
  return getToolActivityCopy(locale).loadTools.displayName;
}

export type LoadToolGroupKind =
  | 'browser'
  | 'computer_use'
  | 'mcp'
  | 'rive'
  | 'agent'
  | 'settings'
  | 'generic';

export interface LoadToolResultDescription {
  kind: LoadToolGroupKind;
  actionLabel: string;
  title: string;
  description: string;
  label: string;
  countLabel: string;
  groupId?: string;
  toolIds: string[];
}

/**
 * Turn a `tool_search` result or historical `load_tools` result into friendly,
 * locale-aware card copy. Returns `null` for unexpected shapes.
 */
export function describeLoadToolResult(
  args: unknown,
  value: unknown,
  locale: UiLocale,
): LoadToolResultDescription | null {
  const record = value as { activated?: unknown; loaded?: unknown } | null | undefined;
  const loaded = record?.activated ?? record?.loaded;
  if (!Array.isArray(loaded) || !loaded.every((name) => typeof name === 'string')) {
    return null;
  }
  const tools = (loaded as string[]).map(safeDisplayText).filter(Boolean);
  const argRecord = args as { group?: unknown; namespace?: unknown } | null | undefined;
  const rawGroup = argRecord?.group ?? argRecord?.namespace;
  const resultGroup = (value as { group?: unknown }).group;
  const groupRecord =
    resultGroup && typeof resultGroup === 'object'
      ? resultGroup as { id?: unknown; label?: unknown; description?: unknown }
      : undefined;
  const groupId = firstSafeText(groupRecord?.id, rawGroup);
  const suppliedLabel = firstSafeText(groupRecord?.label);
  const suppliedDescription = firstSafeText(groupRecord?.description);
  const kind = loadToolGroupKind(groupId, suppliedLabel, tools);
  const n = tools.length;
  const copy = getToolActivityCopy(locale).loadTools;
  if (kind !== 'generic') {
    const groupCopy = copy.groups[kind];
    return {
      kind,
      actionLabel: groupCopy.action,
      title: groupCopy.title,
      description: groupCopy.description,
      label: groupCopy.label,
      countLabel: copy.count(n),
      ...(groupId ? { groupId } : {}),
      toolIds: tools,
    };
  }

  const label = suppliedLabel ?? (locale === 'en' ? 'Tools' : '工具');
  const enableLabel = locale === 'en' ? 'Enable' : locale === 'zh-CN' ? '启用' : '啟用';
  const enabledLabel = locale === 'en' ? 'enabled' : locale === 'zh-CN' ? '已启用' : '已啟用';
  return {
    kind,
    actionLabel: suppliedLabel
      ? `${enableLabel} ${suppliedLabel}`
      : copy.genericAction,
    title: suppliedLabel
      ? `${suppliedLabel} ${enabledLabel}`
      : copy.genericTitle,
    description: suppliedDescription ?? copy.genericDescription,
    label,
    countLabel: copy.count(n),
    ...(groupId ? { groupId } : {}),
    toolIds: tools,
  };
}

function firstSafeText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const safe = safeDisplayText(value);
    if (safe) return safe;
  }
  return undefined;
}

function safeDisplayText(value: string): string {
  return redactSecrets(value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim());
}

function loadToolGroupKind(
  groupId: string | undefined,
  label: string | undefined,
  tools: readonly string[],
): LoadToolGroupKind {
  const id = groupId?.toLowerCase() ?? '';
  const normalizedLabel = label?.toLowerCase() ?? '';
  const names = tools.map((name) => name.toLowerCase());
  const hasTool = (name: string) =>
    names.some((candidate) => candidate === name || candidate.endsWith(`__${name}`));

  if (
    id === 'computer_use'
    || id.endsWith('_desktop_computer_use')
    || normalizedLabel === 'computer use'
    || hasTool('maka_computer')
  ) return 'computer_use';
  if (
    id === 'browser'
    || id.endsWith('_desktop_browser')
    || normalizedLabel === 'browser'
    || hasTool('browser_navigate')
  ) return 'browser';
  if (
    id === 'rive'
    || id.endsWith('_desktop_rive')
    || normalizedLabel === 'rive'
    || hasTool('riveworkflow')
  ) return 'rive';
  if (
    id === 'agent'
    || normalizedLabel === 'agent'
    || hasTool('agent_spawn')
  ) return 'agent';
  if (
    id.endsWith('_desktop_settings')
    || normalizedLabel === 'client settings'
    || hasTool('makasettingsget')
  ) return 'settings';
  if (id.endsWith('_desktop_mcp') || normalizedLabel === 'mcp') return 'mcp';
  return 'generic';
}

export function formatRedactedJson(value: unknown): string {
  try {
    return redactSecrets(JSON.stringify(value, null, 2));
  } catch {
    return redactSecrets(String(value));
  }
}

export function formatToolIntent(intent: string): string {
  const safe = redactSecrets(intent.replace(/\s+/g, ' ').trim());
  return safe.length > 240 ? `${safe.slice(0, 240)}…` : safe;
}
