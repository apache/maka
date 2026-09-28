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
 * The name a tool row shows. A tool carries its own `displayName` when the
 * backend named it; the search/legacy activation connector gets a localized label
 * (its raw name reads as an implementation detail); everything else falls back
 * to the canonical tool name.
 */

import { redactSecrets } from '@maka/core/redaction';
import type { UiLocale } from '@maka/core/ui-locale';
import type { ToolActivityItem } from '../materialize.js';
import { describeLoadToolResult, loadToolDisplayName } from '../tool-format.js';

const CONNECTOR_TOOL_NAMES: ReadonlySet<string> = new Set([
  'tool_search',
  'load_tools',
  'load_tool',
]);

export function isConnectorTool(name: string): boolean {
  return CONNECTOR_TOOL_NAMES.has(name);
}

export function workHubControlStatus(item: ToolActivityItem): string | undefined {
  const args = item.args ?? item.argsPreview;
  if (item.toolName === 'mcp__desktop_workhub__control' && args && typeof args === 'object') {
    const status = (args as Record<string, unknown>).status;
    if (typeof status === 'string' && status.trim() && status.trim().length <= 80 && !/[\r\n]/.test(status)) return redactSecrets(status.trim());
  }
  return undefined;
}

export function resolveToolDisplayName(item: ToolActivityItem, locale: UiLocale): string {
  const status = workHubControlStatus(item);
  if (status) return status;
  if (item.displayName) return item.displayName;
  if (isConnectorTool(item.toolName)) {
    const value = item.result?.kind === 'json' ? item.result.value : undefined;
    return describeLoadToolResult(item.args, value, locale)?.actionLabel
      ?? loadToolDisplayName(locale);
  }
  return item.toolName;
}
