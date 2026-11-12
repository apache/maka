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
  connectionLost(): boolean;
  openSession(sessionId: string | null): Promise<boolean>;
  openSettings(model?: ModelSelection, page?: string): void;
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
  /** Finds or creates the Maka Bot conversation and returns its id. */
  openBot(): Promise<string>;
}

export type QuickIcon =
  | 'app'
  | 'calculator'
  | 'camera'
  | 'clipboard'
  | 'file'
  | 'link'
  | 'note'
  | 'snippet'
  | 'symbol';

/** A result the launcher ranks among every tool's results and draws itself. */
export interface QuickItem {
  /** Stable across runs when `remembered`, and unique within the tool. */
  readonly id: string;
  readonly title: string;
  readonly detail?: string | undefined;
  readonly icon: QuickIcon;
  /** Replaces `icon` once it returns a picture. Read only for rows on screen, so it may load. */
  readonly image?: (() => string | undefined) | undefined;
  /** The kind of result, shown beside it. */
  readonly source: string;
  /** What Return does, named in the launcher's footer. */
  readonly action: string;
  /** How well it matches the query, lower being better. */
  readonly match: number;
  /** Counts its uses for ranking and recommendations; private results leave it unset. */
  readonly remembered?: boolean | undefined;
  run(): void;
}

/** A tool's own line on the launcher's home page. */
export interface QuickEntry {
  /** Unique within the tool and stable across runs and languages: the user's shortcut and alias
   * for the entry are kept under it. */
  readonly id: string;
  readonly title: string;
  readonly icon: QuickIcon;
  /** Searched; the first is shown beside the entry. */
  readonly keywords: readonly string[];
  /** Runs at once; without it, choosing the entry types the first keyword. */
  run?(): void;
}

export interface QuickPreview {
  image?: string | undefined;
  text?: string | undefined;
  fields: readonly { label: string; value: string }[];
}

export interface QuickToolHandle {
  emptyMessage?(): string;
  /** Opts the entered tool into a two-column list and detail view. */
  preview?(itemId: string): QuickPreview | undefined;
  /** Results for the query; for a blank query, whatever could be recommended. */
  items(): readonly QuickItem[];
  entries(): readonly QuickEntry[];
}

/** A tool living in the quick launcher, which draws what it attaches. */
export interface QuickToolInput {
  query(): string;
  /** Dismisses the launcher once a result has done its work. */
  close(): void;
  report(reason: unknown): void;
  attach(handle: QuickToolHandle): void;
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

/** What a conversation drawn compactly, with its input on top, leaves to its host. */
export interface ConversationCompact {
  expand(): void;
  close(): void;
}

export interface ConversationSessionInput {
  readonly shell: ConversationShell;
  /** Sent once the pane can send, in a conversation with no draft. */
  readonly firstMessage?: string | undefined;
  readonly compact?: ConversationCompact | undefined;
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

export const quickToolView = defineUiViewContract<QuickToolInput>('maka.quick-launcher.tool');
/** The workbench's settings page of every quick tool, which holds the tools' own pages. */
export const quickToolsSettings = 'quickTools';

export interface SettingsRoute {
  readonly instance: InstanceId;
  readonly id: string;
}

export interface SettingsViewInput {
  readonly page?: string;
  opened(): boolean;
  close(): void;
  changed(): void;
  readonly model?: ModelSelection;
}

export const settingsViewContract = defineUiViewContract<SettingsViewInput>('maka.settings');

export interface SettingsPageAction {
  label: string;
  run(): void;
  disabled?: boolean;
}

export interface SettingsPageNavigation {
  title(): string;
  nested(): boolean;
  navigation(): string;
  backLabel?(): string;
  back(): boolean;
  /** Runs `next` now, or after the user discards the page's unsaved changes. */
  leave?(next: () => void): void;
  busy?(): boolean;
  /** The page's one command, drawn beside its title. */
  action?(): SettingsPageAction | null;
}

export interface SettingsPageInput {
  readonly settings?: {
    attach(navigation: SettingsPageNavigation): () => void;
  };
}
