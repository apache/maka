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

import type {
  AutomationModule,
  ExtensionModule,
  NavModuleMemory,
  NavSelection,
} from '@maka/ui';
import { safeLocalStorageGet } from './browser-storage.js';

export type NavigationState = {
  selection: NavSelection;
  moduleMemory: NavModuleMemory;
};

const DEFAULT_MODULE_MEMORY: NavModuleMemory = {
  extensions: 'skills',
  automations: 'scheduled-tasks',
};

function defaultNavigationState(): NavigationState {
  return {
    selection: { section: 'sessions' },
    moduleMemory: { ...DEFAULT_MODULE_MEMORY },
  };
}

function isExtensionModule(value: unknown): value is ExtensionModule {
  return value === 'skills' || value === 'mcp';
}

function isAutomationModule(value: unknown): value is AutomationModule {
  return value === 'scheduled-tasks' || value === 'daily-review';
}

function parseSelection(value: unknown): NavSelection | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { section?: unknown; module?: unknown };
  // Any stored `filter` is dropped rather than validated: `archived` named a
  // destination that moved to Settings (#2985) and `flagged` was never written,
  // so every stored value maps to the one session section that exists (#2984).
  if (candidate.section === 'sessions') return { section: 'sessions' };
  if (candidate.section === 'extensions' && isExtensionModule(candidate.module)) {
    return { section: 'extensions', module: candidate.module };
  }
  if (candidate.section === 'automations' && isAutomationModule(candidate.module)) {
    return { section: 'automations', module: candidate.module };
  }

  // Migrate the pre-hub destinations written by maka-nav-selection-v1.
  if (candidate.section === 'skills' || candidate.section === 'mcp') {
    return { section: 'extensions', module: candidate.section };
  }
  if (candidate.section === 'daily-review') {
    return { section: 'automations', module: 'daily-review' };
  }
  if (candidate.section === 'automations') {
    return { section: 'automations', module: 'scheduled-tasks' };
  }
  return null;
}

function parseModuleMemory(value: unknown): NavModuleMemory {
  if (!value || typeof value !== 'object') return { ...DEFAULT_MODULE_MEMORY };
  const candidate = value as { extensions?: unknown; automations?: unknown };
  return {
    extensions: isExtensionModule(candidate.extensions) ? candidate.extensions : DEFAULT_MODULE_MEMORY.extensions,
    automations: isAutomationModule(candidate.automations) ? candidate.automations : DEFAULT_MODULE_MEMORY.automations,
  };
}

export function selectNavigation(state: NavigationState, selection: NavSelection): NavigationState {
  if (selection.section === 'extensions') {
    return {
      selection,
      moduleMemory: { ...state.moduleMemory, extensions: selection.module },
    };
  }
  if (selection.section === 'automations') {
    return {
      selection,
      moduleMemory: { ...state.moduleMemory, automations: selection.module },
    };
  }
  return { selection, moduleMemory: state.moduleMemory };
}

export function parseNavigationState(raw: string | null): NavigationState {
  if (!raw) return defaultNavigationState();
  try {
    const parsed = JSON.parse(raw) as unknown;
    const candidate = parsed && typeof parsed === 'object'
      ? parsed as { selection?: unknown; moduleMemory?: unknown }
      : null;
    const selection = parseSelection(candidate?.selection ?? parsed);
    if (!selection) return defaultNavigationState();
    return selectNavigation(
      {
        selection,
        moduleMemory: parseModuleMemory(candidate?.moduleMemory),
      },
      selection,
    );
  } catch {
    return defaultNavigationState();
  }
}

export function readNavigationState(): NavigationState {
  return parseNavigationState(safeLocalStorageGet('maka-nav-selection-v1'));
}
