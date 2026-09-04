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
 * The name a tool row shows. Maka-owned tools use locale copy, connectors use
 * their activation summary, and external tools keep their provider label before
 * falling back to the canonical tool name.
 */

import type { UiLocale } from '@maka/core/ui-locale';
import type { ToolActivityItem } from '../materialize.js';
import { describeLoadToolResult, loadToolDisplayName } from '../tool-format.js';
import { getBuiltinToolLabel } from './copy.js';

const CONNECTOR_TOOL_NAMES: ReadonlySet<string> = new Set([
  'tool_search',
  'load_tools',
  'load_tool',
]);

const BUILTIN_PROXY_PREFIXES = [
  'mcp__desktop_browser__',
  'mcp__desktop_computer_use__',
  'mcp__desktop_settings__',
  'mcp__desktop_rive__',
] as const;

export function isConnectorTool(name: string): boolean {
  return CONNECTOR_TOOL_NAMES.has(name);
}

export function resolveToolName(
  toolName: string,
  displayName: string | undefined,
  locale: UiLocale,
): string {
  if (isConnectorTool(toolName)) return loadToolDisplayName(locale);
  const proxyPrefix = BUILTIN_PROXY_PREFIXES.find((prefix) => toolName.startsWith(prefix));
  const builtinLabel = getBuiltinToolLabel(
    proxyPrefix ? toolName.slice(proxyPrefix.length) : toolName,
    locale,
  );
  return (builtinLabel ?? displayName) || toolName;
}

export function resolveToolDisplayName(item: ToolActivityItem, locale: UiLocale): string {
  if (isConnectorTool(item.toolName)) {
    const value = item.result?.kind === 'json' ? item.result.value : undefined;
    return describeLoadToolResult(item.args, value, locale)?.actionLabel
      ?? loadToolDisplayName(locale);
  }
  return resolveToolName(item.toolName, item.displayName, locale);
}
