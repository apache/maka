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

import type { ExecutorCatalogEntry } from '@maka/core/executor-catalog';
import type { ProviderType } from '@maka/core/llm-connections';
import { Bot } from '@maka/ui/icons';
import type { ReactNode } from 'react';

const antigravityMark = new URL('../../../assets/provider-brands/antigravity.svg', import.meta.url).href;
const makaMark = new URL('../../../../../assets/app-icons/sky.png', import.meta.url).href;

// Agent identity is independent of the models an ACP process exposes.
const AGENT_BRANDS: Readonly<Record<string, ProviderType>> = {
  codex: 'openai',
  'codex-acp': 'openai',
  'codex.app-server': 'openai',
  claude: 'anthropic',
  'claude-agent': 'anthropic',
  'claude-code': 'anthropic',
  'claude-code-acp': 'anthropic',
  gemini: 'google',
  'gemini-cli': 'google',
  'gemini-cli-acp': 'google',
  opencode: 'opencode',
  'opencode-acp': 'opencode',
};

export function ExecutorBrandMark({ entry, renderProviderMark }: {
  entry?: ExecutorCatalogEntry;
  renderProviderMark?(type: ProviderType): ReactNode;
}) {
  if (!entry) return <img className="maka-executor-brand-mark-native" src={makaMark} alt="" />;
  const id = entry.id.toLowerCase();
  if (id === 'antigravity-acp' || id === 'antigravity') return <img src={antigravityMark} alt="" />;
  const provider = AGENT_BRANDS[id];
  return (provider && renderProviderMark?.(provider)) || <Bot size={24} aria-hidden="true" />;
}
