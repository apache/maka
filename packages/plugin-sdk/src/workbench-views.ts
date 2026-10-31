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

import type { InstanceId, ModelSelection } from './generated/runtime.js';
import { defineUiViewContract } from './workbench.js';
import type { ComposerViewInput } from './composer-view.js';

export type * from './composer-view.js';
export * from './workspace-view.js';

/** Routing and presentation operations owned by the selected workbench root. */
export interface ConversationShell {
  sessionId(): string | null;
  visible(): boolean;
  blocked(): boolean;
  openSession(sessionId: string | null): Promise<boolean>;
  openSettings(model?: ModelSelection): void;
  sidebarShown(): boolean;
  sidebarDocked(): boolean;
  previewDocked(): boolean;
  showSidebar(): void;
  hideSidebar(): void;
  dismissRoute(): boolean;
  /** Opens a conversation in another pane beside this one, where the shell has them. */
  openBeside?(sessionId: string): void;
  /** The conversations open in panes beside this one, left to right. */
  besideSessionIds?(): readonly string[];
  /** Present on a pane the shell opened beside another: closes that pane. */
  closePane?(): void;
}

export interface ConversationSessionHandle {
  leave(): Promise<boolean>;
}

export interface ConversationPreviewHandle {
  shown(): boolean;
  modalSuppressed(): boolean;
  close(): void;
  focused(): boolean;
}

export interface ConversationNavigationInput {
  readonly shell: ConversationShell;
}

export interface ConversationSessionInput {
  readonly shell: ConversationShell;
  attach(handle: ConversationSessionHandle): void;
}

export interface ConversationPreviewInput {
  readonly shell: ConversationShell;
  readonly surface: 'pane' | 'overlays';
  readonly docked: boolean;
  attach(handle: ConversationPreviewHandle): void;
}

export const composerViewContract = defineUiViewContract<ComposerViewInput>('maka.composer');

export const conversationNavigationView = defineUiViewContract<ConversationNavigationInput>(
  'maka.conversations.navigation',
);
export const conversationSessionView = defineUiViewContract<ConversationSessionInput>(
  'maka.conversations.session',
);
export const conversationPreviewView = defineUiViewContract<ConversationPreviewInput>(
  'maka.conversations.preview',
);

export interface SettingsRoute {
  readonly instance: InstanceId;
  readonly id: string;
}

export interface SettingsViewInput {
  opened(): boolean;
  close(): void;
  changed(): void;
  readonly model?: ModelSelection;
}

export const settingsViewContract = defineUiViewContract<SettingsViewInput>('maka.settings');

export interface SettingsPageNavigation {
  title(): string;
  nested(): boolean;
  navigation(): string;
  backLabel?(): string;
  back(): boolean;
  busy?(): boolean;
}

export interface SettingsPageInput {
  readonly settings?: {
    attach(navigation: SettingsPageNavigation): () => void;
  };
}
