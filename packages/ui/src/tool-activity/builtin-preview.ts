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
 * Re-export the shared quiet-panel formatting from `@maka/core` (#1065).
 *
 * `formatToolInvocationLine` and `formatQuietJsonValue` are pure functions
 * extracted from this module into `@maka/core` so the CLI/TUI can consume
 * the same path. Desktop passes the resolved locale from `LocaleProvider`.
 *
 * The desktop `ToolActivityItem`-typed signature is adapted here so existing
 * call sites (`tool-activity.tsx`, `tool-result-preview.tsx`) keep their
 * `Pick<ToolActivityItem, ...>` parameter without depending on the core
 * `ToolInvocationInput` type.
 */
import {
  formatQuietJsonValue as coreFormatQuietJsonValue,
  formatToolInvocationLine as coreFormatToolInvocationLine,
} from '@maka/core/tool-quiet-preview';
import { type UiLocale } from '@maka/core/ui-locale';
import type { ToolActivityItem } from '../materialize.js';

export type { QuietPreview } from '@maka/core/tool-quiet-preview';

/** Desktop-adapted wrapper with an explicit resolved locale. */
export function formatToolInvocationLine(
  item: Pick<ToolActivityItem, 'toolName' | 'args' | 'activityKind'>,
  locale: UiLocale,
): string | undefined {
  return coreFormatToolInvocationLine(
    { toolName: item.toolName, args: item.args },
    locale,
  );
}

/** Desktop-adapted wrapper with an explicit resolved locale. */
export function formatQuietJsonValue(
  value: unknown,
  locale: UiLocale,
): import('@maka/core/tool-quiet-preview').QuietPreview {
  return coreFormatQuietJsonValue(value, locale);
}
