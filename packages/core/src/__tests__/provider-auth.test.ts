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

    assert.strictEqual(missing.setupMode, 'api_key');
    assert.strictEqual(missing.state, 'not_configured');
    assert.strictEqual(missing.validationStatus, 'not_run');
    assert.strictEqual(missing.requiresSecret, true);
    assert.strictEqual(missing.sendMayUseWithoutSecret, false);
    assert.strictEqual(missing.actionAvailability.save_secret, 'available');
    assert.strictEqual(missing.actionAvailability.test_credentials, 'hidden');
    assert.strictEqual(missing.actionAvailability.fetch_models, 'hidden');
    assert.strictEqual(missing.actionAvailability.start_oauth, 'hidden');

    const configured = deriveProviderAuthContract({
      providerType: 'openai',
      hasSecret: true,
    });

    assert.strictEqual(configured.state, 'configured');
    assert.strictEqual(configured.actionAvailability.test_credentials, 'available');
    assert.strictEqual(configured.actionAvailability.fetch_models, 'available');
    assert.strictEqual(configured.actionAvailability.revoke_auth, 'available');
  });

  test('maps verified credentials to validation state', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'zai-coding-plan',
      hasSecret: true,
      lastTestStatus: 'verified',
    });

    assert.strictEqual(contract.state, 'validated');
    assert.strictEqual(contract.validationStatus, 'verified');
  });

  test('maps authentication failures to distinct repair states', () => {
    const needsReauth = deriveProviderAuthContract({
      providerType: 'anthropic',
      hasSecret: true,
      lastTestStatus: 'needs_reauth',
    });
    const error = deriveProviderAuthContract({
      providerType: 'anthropic',
      hasSecret: true,
      lastTestStatus: 'error',
    });

    assert.strictEqual(needsReauth.state, 'needs_reauth');
    assert.strictEqual(error.state, 'error');
  });

  test('OAuth subscription providers expose validation actions after login', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'xai-oauth',
      hasSecret: true,
      lastTestStatus: 'verified',
    });

    assert.strictEqual(contract.setupMode, 'oauth');
    assert.strictEqual(contract.state, 'validated');
    assert.strictEqual(contract.validationStatus, 'verified');
    assert.strictEqual(contract.requiresSecret, true);
    assert.strictEqual(contract.sendMayUseWithoutSecret, false);
    assert.strictEqual(contract.actionAvailability.save_secret, 'hidden');
    assert.strictEqual(contract.actionAvailability.test_credentials, 'available');
    assert.strictEqual(contract.actionAvailability.start_oauth, 'hidden');
    assert.strictEqual(contract.actionAvailability.refresh_oauth, 'available');
    assert.strictEqual(contract.actionAvailability.revoke_auth, 'available');
  });

  test('a discovery-capable OAuth provider keeps fetch_models available after login', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'openai-codex',
      hasSecret: true,
      lastTestStatus: 'verified',
    });

    assert.strictEqual(contract.setupMode, 'oauth');
    assert.strictEqual(contract.actionAvailability.fetch_models, 'available');
  });

  test('OAuth subscription providers route missing login to the OAuth setup path', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'openai-codex',
      hasSecret: false,
    });

    assert.strictEqual(contract.setupMode, 'oauth');
    assert.strictEqual(contract.state, 'not_configured');
    assert.strictEqual(contract.validationStatus, 'not_run');
    assert.strictEqual(contract.actionAvailability.start_oauth, 'available');
    assert.strictEqual(contract.actionAvailability.test_credentials, 'hidden');
    assert.strictEqual(contract.actionAvailability.fetch_models, 'hidden');
  });

  test('no-auth local providers can send without secret but are still not validated runtime probes', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'ollama',
      hasSecret: false,
    });

    assert.strictEqual(contract.setupMode, 'none');
    assert.strictEqual(contract.state, 'configured');
    assert.strictEqual(contract.validationStatus, 'not_required');
    assert.strictEqual(contract.requiresSecret, false);
    assert.strictEqual(contract.sendMayUseWithoutSecret, true);
    assert.strictEqual(contract.actionAvailability.save_secret, 'hidden');
    assert.strictEqual(contract.actionAvailability.test_credentials, 'available');
    assert.strictEqual(contract.actionAvailability.fetch_models, 'available');
  });

  test('LocalAI keeps API-key setup available without making the key required', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'localai',
      hasSecret: false,
    });

    assert.strictEqual(contract.setupMode, 'api_key');
    assert.strictEqual(contract.state, 'configured');
    assert.strictEqual(contract.validationStatus, 'not_required');
    assert.strictEqual(contract.requiresSecret, false);
    assert.strictEqual(contract.sendMayUseWithoutSecret, true);
    assert.strictEqual(contract.actionAvailability.save_secret, 'available');
    assert.strictEqual(contract.actionAvailability.test_credentials, 'available');
    assert.strictEqual(contract.actionAvailability.fetch_models, 'available');
  });

  test('LocalAI preserves endpoint validation failures without making its optional key required', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'localai',
      hasSecret: true,
      lastTestStatus: 'needs_reauth',
    });

    assert.strictEqual(contract.state, 'needs_reauth');
    assert.strictEqual(contract.validationStatus, 'needs_reauth');
    assert.strictEqual(contract.requiresSecret, false);
    assert.strictEqual(contract.sendMayUseWithoutSecret, true);
  });

  test('disabled providers hide actions regardless of stored credential state', () => {
    const contract = deriveProviderAuthContract({
      providerType: 'openai-codex',
      enabled: false,
      hasSecret: true,
      lastTestStatus: 'verified',
    });

    assert.strictEqual(contract.setupMode, 'oauth');
    assert.strictEqual(contract.state, 'disabled');
    assert.strictEqual(contract.validationStatus, 'verified');
    assert.strictEqual(
      Object.values(contract.actionAvailability).every((value) => value === 'hidden'),
      true,
    );
  });
});
