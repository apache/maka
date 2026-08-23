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

import type { SessionViewMode } from '@maka/ui';
import { safeLocalStorageGet, safeLocalStorageSet } from './browser-storage.js';

export const SESSION_LIST_EXPANDED_DEFAULT_WIDTH = 260;
export const SESSION_LIST_EXPANDED_MIN_WIDTH = 180;
export const SESSION_LIST_EXPANDED_MAX_WIDTH = 480;

const SESSION_LIST_VIEW_MODE_KEY = 'maka-chat-list-view-mode-v1';

export function readSessionListViewMode(): SessionViewMode {
  const stored = safeLocalStorageGet(SESSION_LIST_VIEW_MODE_KEY);
  if (stored === 'project' || stored === 'conversation') return stored;
  return 'conversation';
}

export function writeSessionListViewMode(mode: SessionViewMode): void {
  safeLocalStorageSet(SESSION_LIST_VIEW_MODE_KEY, mode);
}

export function readSessionListWidth(): number {
  const stored = Number(safeLocalStorageGet('maka-chat-list-width-v1'));
  if (Number.isFinite(stored) && stored > 0) return clampSessionListWidth(stored);
  return SESSION_LIST_EXPANDED_DEFAULT_WIDTH;
}

export function readSessionListCollapsed(): boolean {
  const stored = safeLocalStorageGet('maka-chat-list-collapsed-v1');
  if (stored === 'false') return false;
  if (stored === 'true') return true;
  return true;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampSessionListWidth(value: number): number {
  return Math.round(clamp(value, SESSION_LIST_EXPANDED_MIN_WIDTH, SESSION_LIST_EXPANDED_MAX_WIDTH));
}
