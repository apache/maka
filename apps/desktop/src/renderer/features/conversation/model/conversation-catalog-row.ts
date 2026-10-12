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

import { valuesEqual } from '@maka/ui';
import type { DesktopSessionSummary } from '../../../../shared/desktop-session-projection.js';

/**
 * Catalog bookkeeping that republishes at event rate but renders only in the
 * rail — ordering, unread and flag markers, preview text, admission revision.
 * Nothing under the shell's whole-row read renders them, so a patch that moves
 * only these fields must not re-render the whole chat surface. Every other
 * field still compares, and a row field added later republishes until someone
 * proves it belongs here — the failure direction is a re-render, not a stale
 * value the UI swears is current.
 */
const NON_RENDERED_ROW_KEYS = {
  activityAt: true,
  hasUnread: true,
  isFlagged: true,
  lastMessagePreview: true,
  localCreatedAt: true,
  revision: true,
  statusUpdatedAt: true,
  subagentRuntime: true,
} satisfies Partial<Record<keyof DesktopSessionSummary, true>>;

export function shellSessionRowEqual(
  a: DesktopSessionSummary | undefined,
  b: DesktopSessionSummary | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  const keys = new Set([
    ...(Object.keys(a) as (keyof DesktopSessionSummary)[]),
    ...(Object.keys(b) as (keyof DesktopSessionSummary)[]),
  ]);
  for (const key of keys) {
    if (key in NON_RENDERED_ROW_KEYS) continue;
    if (!valuesEqual(a[key], b[key])) return false;
  }
  return true;
}
