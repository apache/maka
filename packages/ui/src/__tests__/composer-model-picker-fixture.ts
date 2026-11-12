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

import assert from 'node:assert/strict';
import { act } from 'react';
import type { SessionSummary } from '@maka/core/session';
import type { ChatModelChoice } from '@maka/core/chat-model-choice';
import type { ComposerExecutorPicker } from '../composer-model-picker.js';
import type { installTranscriptDom } from './transcript-test-dom.js';

export const choices: ChatModelChoice[] = ['first', 'second'].map(connectionId => ({
  connectionId, connectionSlug: connectionId, connectionName: connectionId, providerType: 'openai',
  providerLabel: 'OpenAI', model: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', isDefault: false,
  contextWindow: 1_048_576, thinkingLevels: ['low', 'high'],
}));
export const session = (id: string) => ({ id, llmConnectionId: 'first', llmConnectionSlug: 'first', model: 'gpt-6.1-sol' }) as SessionSummary;
export const catalog: ComposerExecutorPicker['catalog'] = [{
  id: 'agent', displayName: 'Agent', readiness: 'ready', supportsModelChange: true, supportsAttachments: false,
  currentModel: 'opaque-high', currentMode: 'plan', supportsModeChange: true,
  models: [{ id: 'opaque-high', name: 'Family High' }, { id: 'opaque-low', name: 'Family Low' }, { id: 'other', name: 'Other' }],
  modelGroups: [{ id: 'family', name: 'Family', variants: [{ modelId: 'opaque-high', level: 'high' }, { modelId: 'opaque-low', level: 'low' }] }],
  modes: [{ id: 'plan', name: 'Plan' }, { id: 'code', name: 'Code' }],
}];
export function actions(dom: ReturnType<typeof installTranscriptDom>) {
  return {
    click: async (element: Element | null | undefined) => {
      assert.ok(element);
      await act(async () => { element.dispatchEvent(new dom.window.Event('click', { bubbles: true })); });
    },
    option: (name: string) => [...dom.document.querySelectorAll('[role="option"]')].find(el => el.textContent === name),
    trigger: (selector = '.maka-model-switcher-trigger') => dom.document.querySelector(selector + ' button'),
  };
}
