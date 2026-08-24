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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { expect } from '../test-helpers.js';
import { createDefaultSettings } from '@maka/core/settings';
import { type LlmConnection } from '@maka/core/llm-connections';
import { createConfiguredSubagentCatalog } from '../configured-subagent-catalog.js';

const connection: LlmConnection = {
  slug: 'worker-provider',
  name: 'Worker provider',
  providerType: 'openai',
  defaultModel: 'gpt-5-mini',
  enabledModelIds: ['gpt-5-mini'],
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

describe('configured subagent catalog', () => {
  test('lists availability and resolves only enabled user-approved targets', async () => {
    const settings = createDefaultSettings();
    settings.subagents.presets = [
      {
        id: 'fast-reader',
        name: 'Fast reader',
        description: 'Cheap scans',
        profile: 'local_read',
        connectionSlug: connection.slug,
        model: 'gpt-5-mini',
        enabled: true,
      },
      {
        id: 'missing-model',
        name: 'Missing model',
        description: '',
        profile: 'local_read',
        connectionSlug: connection.slug,
        model: 'gpt-5-nano',
        enabled: true,
      },
    ];
    const catalog = createConfiguredSubagentCatalog({
      getPresets: async () => settings.subagents.presets,
      getConnection: async (slug) => (slug === connection.slug ? connection : null),
    });

    expect(
      (await catalog.list()).map(({ id, availability }) => ({
        id,
        availability,
      })),
    ).toEqual([
      { id: 'fast-reader', availability: { status: 'available' } },
      {
        id: 'missing-model',
        availability: { status: 'unavailable', reason: 'model_disabled' },
      },
    ]);
    expect(await catalog.resolve('fast-reader')).toEqual(settings.subagents.presets[0]);
    await assert.rejects(catalog.resolve('missing-model'), /model_disabled/);
    await assert.rejects(catalog.resolve('invented'), /Call agent_list/);
  });

  test('a retained retired connection cannot admit a subagent', async () => {
    // Retirement keeps the connection enabled — the row exists so the
    // credential stays visible and deletable — so the `enabled` and model
    // checks alone would call this preset available and let a spawn or graph
    // provisioning persist a child that can never execute.
    const retired: LlmConnection = {
      ...connection,
      slug: 'claude-subscription',
      name: 'Claude Subscription',
      providerType: 'claude-subscription',
      defaultModel: 'claude-opus-5',
      enabledModelIds: ['claude-opus-5'],
    };
    const settings = createDefaultSettings();
    settings.subagents.presets = [
      {
        id: 'retired-worker',
        name: 'Retired worker',
        description: '',
        profile: 'local_read',
        connectionSlug: retired.slug,
        model: 'claude-opus-5',
        enabled: true,
      },
    ];
    const catalog = createConfiguredSubagentCatalog({
      getPresets: async () => settings.subagents.presets,
      getConnection: async (slug) => (slug === retired.slug ? retired : null),
    });

    expect((await catalog.list())[0]?.availability).toEqual({
      status: 'unavailable',
      reason: 'provider_retired',
    });
    await assert.rejects(catalog.resolve('retired-worker'), /provider_retired/);
  });
});
