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
import { deriveProviderAuthContract } from '../provider-auth.js';

describe('ProviderAuth contract', () => {
  test('model-key providers expose credential actions only after a secret exists', () => {
    const missing = deriveProviderAuthContract({
      providerType: 'openai',
      hasSecret: false,
    });

    assert.strictEqual(missing.requiresSecret, true);
    assert.strictEqual(missing.actionAvailability.test_credentials, false);
    assert.strictEqual(missing.actionAvailability.fetch_models, false);
    assert.strictEqual(missing.actionAvailability.start_oauth, false);

    const configured = deriveProviderAuthContract({
      providerType: 'openai',
      hasSecret: true,
    });

    assert.strictEqual(configured.actionAvailability.test_credentials, true);
    assert.strictEqual(configured.actionAvailability.fetch_models, true);
  });

  test('OAuth subscription providers expose validation actions after login', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'xai-oauth',
      hasSecret: true,
    });

    assert.strictEqual(contract.requiresSecret, true);
    assert.strictEqual(contract.actionAvailability.test_credentials, true);
    assert.strictEqual(contract.actionAvailability.start_oauth, false);
  });

  test('a discovery-capable OAuth provider keeps fetch_models available after login', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'openai-codex',
      hasSecret: true,
    });

    assert.strictEqual(contract.actionAvailability.fetch_models, true);
  });

  test('OAuth subscription providers route missing login to the OAuth setup path', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'openai-codex',
      hasSecret: false,
    });

    assert.strictEqual(contract.actionAvailability.start_oauth, true);
    assert.strictEqual(contract.actionAvailability.test_credentials, false);
    assert.strictEqual(contract.actionAvailability.fetch_models, false);
  });

  test('no-auth local providers can test and fetch without ever holding a secret', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'ollama',
      hasSecret: false,
    });

    assert.strictEqual(contract.requiresSecret, false);
    assert.strictEqual(contract.actionAvailability.test_credentials, true);
    assert.strictEqual(contract.actionAvailability.fetch_models, true);
  });

  test('an optional-key provider admits testing and fetching before a key exists', () => {
    // LocalAI accepts a key but does not require one, so waiting for a saved
    // secret would refuse an instance that is already reachable.
    const contract = deriveProviderAuthContract({
      providerType: 'localai',
      hasSecret: false,
    });

    assert.strictEqual(contract.requiresSecret, false);
    assert.strictEqual(contract.actionAvailability.test_credentials, true);
    assert.strictEqual(contract.actionAvailability.fetch_models, true);
  });
});
