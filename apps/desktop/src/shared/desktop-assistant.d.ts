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

import type { SettingsSection, ThemePreference } from '@maka/core/settings';
import type { UiLocalePreference } from '@maka/core/ui-locale';
import type { ChatModelChoice } from '@maka/core/chat-model-choice';

export type DesktopAssistantAction =
  | { readonly kind: 'navigate'; readonly section: SettingsSection }
  | { readonly kind: 'set'; readonly target: 'language'; readonly value: UiLocalePreference }
  | { readonly kind: 'set'; readonly target: 'theme'; readonly value: ThemePreference }
  | { readonly kind: 'set'; readonly target: 'displayName'; readonly value: string };

export interface DesktopAssistantMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

export type DesktopAssistantPhase = 'idle' | 'thinking' | 'acting' | 'paused' | 'completed' | 'error';

export interface DesktopAssistantSnapshot {
  readonly revision: number;
  readonly open: boolean;
  readonly expanded: boolean;
  readonly phase: DesktopAssistantPhase;
  readonly messages: readonly DesktopAssistantMessage[];
  readonly action?: DesktopAssistantAction;
  readonly error?: string;
  readonly canUndo: boolean;
  readonly modelChoices?: readonly ChatModelChoice[];
  readonly model?: ChatModelChoice;
  readonly cursor?: { readonly x: number; readonly y: number; readonly clicking: boolean };
}

export interface DesktopAssistantBridge {
  getSnapshot(): Promise<DesktopAssistantSnapshot>;
  open(): Promise<void>;
  close(): Promise<void>;
  expand(): Promise<void>;
  submit(text: string): Promise<void>;
  selectModel(connectionId: string, model: string): Promise<void>;
  stop(): Promise<void>;
  undo(): Promise<void>;
  subscribe(handler: (snapshot: DesktopAssistantSnapshot) => void): () => void;
}
