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
import { describe, test } from 'node:test';
import { createDefaultSettings, mergeSettings } from '@maka/core/settings';
import {
  getTavilyCredentialSource,
  getTavilyEnvApiKey,
  resolveTavilyApiKey,
} from '../web-search/credentials.js';

describe('web search credential source', () => {
  test('reads Tavily keys from environment without exposing the value in source state', () => {
    assert.equal(getTavilyEnvApiKey({ TAVILY_API_KEY: '  tvly-env  ' }), 'tvly-env');
    assert.equal(getTavilyEnvApiKey({ MAKA_TAVILY_API_KEY: 'maka-env' }), 'maka-env');
    assert.equal(getTavilyEnvApiKey({ TAVILY_API_KEY: '   ' }), '');
  });

  test('uses env before saved key and draft before both', () => {
    const settings = mergeSettings(createDefaultSettings(), {
      webSearch: { providers: { tavily: { apiKey: 'saved-key' } } },
    });

    assert.equal(getTavilyCredentialSource(settings, { TAVILY_API_KEY: 'env-key' }), 'env');
    assert.equal(resolveTavilyApiKey({ settings, env: { TAVILY_API_KEY: 'env-key' } }), 'env-key');
    assert.equal(
      resolveTavilyApiKey({ settings, draftKey: ' draft-key ', env: { TAVILY_API_KEY: 'env-key' } }),
      'draft-key',
    );
  });

  test('falls back to saved key, then none', () => {
    const settings = createDefaultSettings();
    assert.equal(getTavilyCredentialSource(settings, {}), 'none');
    assert.equal(resolveTavilyApiKey({ settings, env: {} }), '');

    const saved = mergeSettings(settings, {
      webSearch: { providers: { tavily: { apiKey: 'saved-key' } } },
    });
    assert.equal(getTavilyCredentialSource(saved, {}), 'saved');
    assert.equal(resolveTavilyApiKey({ settings: saved, env: {} }), 'saved-key');
  });
});
