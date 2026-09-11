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
  SessionWorkbarPlacement,
  SessionWorkbarTabKind,
} from './workbar-tabs.js';

export interface WorkbarToolDefinition {
  readonly kind: SessionWorkbarTabKind;
  readonly labelKey: SessionWorkbarTabKind;
  readonly icon:
    | 'activity'
    | 'file-diff'
    | 'folder'
    | 'globe'
    | 'list-todo'
    | 'message-circle-question'
    | 'terminal';
  readonly shortcut?: string;
  readonly persisted: boolean;
  readonly singleton: boolean;
  readonly defaultPlacement: SessionWorkbarPlacement;
}

type WorkbarToolDefinitionsByKind = {
  readonly [Kind in SessionWorkbarTabKind]: WorkbarToolDefinition & {
    readonly kind: Kind;
  };
};

const WORKBAR_TOOL_DEFINITION_BY_KIND = {
  'side-chat': {
    kind: 'side-chat',
    labelKey: 'side-chat',
    icon: 'message-circle-question',
    shortcut: 'mod+alt+s',
    persisted: false,
    singleton: false,
    defaultPlacement: 'right',
  },
  review: {
    kind: 'review',
    labelKey: 'review',
    // The face lists changed files and their diffs, so it carries the diff
    // glyph. `git-branch` read as "switch branch", which the face never does.
    icon: 'file-diff',
    shortcut: 'ctrl+shift+g',
    persisted: true,
    singleton: true,
    defaultPlacement: 'right',
  },
  terminal: {
    kind: 'terminal',
    labelKey: 'terminal',
    icon: 'terminal',
    shortcut: 'ctrl+`',
    persisted: false,
    singleton: false,
    defaultPlacement: 'right',
  },
  browser: {
    kind: 'browser',
    labelKey: 'browser',
    icon: 'globe',
    shortcut: 'mod+t',
    persisted: true,
    singleton: true,
    defaultPlacement: 'right',
  },
  files: {
    kind: 'files',
    labelKey: 'files',
    icon: 'folder',
    shortcut: 'mod+p',
    persisted: true,
    singleton: true,
    defaultPlacement: 'right',
  },
  'work-board': {
    kind: 'work-board',
    labelKey: 'work-board',
    icon: 'list-todo',
    persisted: true,
    singleton: true,
    defaultPlacement: 'right',
  },
  inspector: {
    kind: 'inspector',
    labelKey: 'inspector',
    icon: 'activity',
    persisted: true,
    singleton: true,
    defaultPlacement: 'right',
  },
} as const satisfies WorkbarToolDefinitionsByKind;

export type RegisteredWorkbarToolDefinition =
  (typeof WORKBAR_TOOL_DEFINITION_BY_KIND)[SessionWorkbarTabKind];

/**
 * Registry order is the order the launcher and the [+] menu list the faces in.
 * Typed as the declared shape rather than the const union so a reader can ask
 * every entry for its optional `shortcut`.
 */
export const WORKBAR_TOOL_DEFINITIONS: readonly WorkbarToolDefinition[] =
  Object.values(WORKBAR_TOOL_DEFINITION_BY_KIND);

export function workbarToolDefinition(
  kind: SessionWorkbarTabKind,
): RegisteredWorkbarToolDefinition {
  return WORKBAR_TOOL_DEFINITION_BY_KIND[kind];
}

export function isPersistedWorkbarTool(
  kind: SessionWorkbarTabKind,
): boolean {
  return workbarToolDefinition(kind).persisted;
}
