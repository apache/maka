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

import type { PermissionMode } from './permission.js';

/**
 * A product intent a caller can open a new session at, distinct from the
 * ordinary chat that needs no intent at all. Absence is spelled `undefined`,
 * not a `'chat'` member: a second spelling of "no mode" is a second thing to
 * keep in agreement.
 */
export interface SessionStartModeSpec {
  /** Omitted where the mode keeps the caller's name, as `bot` does. */
  readonly name?: string;
  readonly labels: readonly string[];
  readonly permissionMode: PermissionMode;
}

export const SESSION_START_MODE_SPECS = {
  deep_research: {
    name: 'Deep Research',
    labels: ['mode:deep_research'],
    permissionMode: 'explore',
  },
  bot: {
    labels: ['mode:bot'],
    permissionMode: 'explore',
  },
} as const satisfies Record<string, SessionStartModeSpec>;

export type SessionStartMode = keyof typeof SESSION_START_MODE_SPECS;
export const SESSION_START_MODES: readonly SessionStartMode[] = Object.keys(
  SESSION_START_MODE_SPECS,
) as SessionStartMode[];
export const SESSION_START_MODE_LABELS: readonly string[] = [
  ...new Set(Object.values(SESSION_START_MODE_SPECS).flatMap((spec) => spec.labels)),
];

export function isSessionStartMode(value: unknown): value is SessionStartMode {
  return typeof value === 'string' && Object.hasOwn(SESSION_START_MODE_SPECS, value);
}

export function sessionStartModeSpec(mode: SessionStartMode): SessionStartModeSpec {
  return SESSION_START_MODE_SPECS[mode];
}

export function isSessionStartModeLabel(value: unknown): value is string {
  return typeof value === 'string' && SESSION_START_MODE_LABELS.includes(value);
}
