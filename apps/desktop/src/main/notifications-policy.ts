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

import type { UiLocale } from '@maka/core/ui-locale';

/**
 * Pure decision + copy helpers for desktop run-completion notifications.
 *
 * Kept free of any `electron` import so the gating logic can be unit
 * tested under plain `node --test` (the IPC glue in
 * `notifications-ipc-main.ts` owns everything Electron-shaped). The
 * renderer only reports *that* a turn ended; the main process decides
 * whether to actually raise an OS notification.
 */

/** Terminal states a turn can reach that are worth notifying about. */
export type RunNotificationKind = 'completed' | 'errored';

export function isRunNotificationKind(value: unknown): value is RunNotificationKind {
  return value === 'completed' || value === 'errored';
}

export interface RunNotificationGate {
  /** Product toggle: `settings.notifications.runComplete`. */
  readonly enabled: boolean;
  /** Electron `Notification.isSupported()` for the current platform. */
  readonly supported: boolean;
  /**
   * Whether the main window currently holds OS focus. We suppress the
   * notification when focused — the user is already looking at Maka, so
   * a banner would be pure noise.
   */
  readonly windowFocused: boolean;
  /**
   * `settings.privacy.incognitoActive`. A banner carries the session
   * name + reply/error preview *outside* the app (Notification Center,
   * lock screen), which contradicts incognito, so we suppress entirely
   * — consistent with incognito pausing local memory / search.
   */
  readonly incognito: boolean;
  /** Automated desktop runs must never emit native OS notifications. */
  readonly e2e: boolean;
}

/**
 * Single source of truth for "should we raise a native notification for
 * this finished turn". All gates must pass; order is irrelevant because
 * the predicate is a plain conjunction.
 */
export function shouldRaiseRunNotification(gate: RunNotificationGate): boolean {
  return gate.enabled && gate.supported && !gate.windowFocused && !gate.incognito && !gate.e2e;
}

export interface RunNotificationCopy {
  readonly title: string;
  readonly body: string;
}

/**
 * Generic fallback text, keyed by terminal kind. Used when the renderer
 * could not supply a session name / reply preview (e.g. an untitled
 * session or a tool-only turn with no assistant text).
 */
export function runNotificationCopy(
  kind: RunNotificationKind,
  locale: UiLocale,
): RunNotificationCopy {
  if (locale === 'en') {
    return kind === 'errored'
      ? { title: 'Conversation error', body: 'This response did not finish. Click to view details.' }
      : { title: 'Response ready', body: 'Maka finished this response. Click to view it.' };
  }
  if (kind === 'errored') {
    return { title: '任务出错', body: '本轮回答未能完成，点击查看详情。' };
  }
  return { title: '回答已生成', body: 'Maka 已完成本轮回答，点击查看。' };
}

/** Renderer-supplied content for a finished turn. Both fields are
 * best-effort: `title` is the session name, `body` the start of the
 * reply (or the error message). Either may be missing/blank. */
export interface RunNotificationInput {
  readonly kind: RunNotificationKind;
  readonly title?: unknown;
  readonly body?: unknown;
}

// The OS truncates long banners anyway; cap defensively so a runaway
// reply (renderer bug, no-whitespace blob) can't bloat the payload.
const MAX_TITLE_CHARS = 80;
const MAX_BODY_CHARS = 160;

/**
 * Collapse a renderer-supplied string into a single trimmed line,
 * hard-capped with an ellipsis. Non-strings and blanks return '' so the
 * caller can fall back. Kept defensive because the value crosses the IPC
 * boundary as `unknown`.
 */
function sanitizeLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Final notification text: prefer the renderer's session name + reply
 * preview, falling back per-field to the generic copy when a field is
 * missing or blank. Sanitization + capping live here so the IPC handler
 * stays a thin shell and the logic is unit-testable without Electron.
 */
export function resolveNotificationContent(
  input: RunNotificationInput,
  locale: UiLocale,
): RunNotificationCopy {
  const fallback = runNotificationCopy(input.kind, locale);
  return {
    title: sanitizeLine(input.title, MAX_TITLE_CHARS) || fallback.title,
    body: sanitizeLine(input.body, MAX_BODY_CHARS) || fallback.body,
  };
}
