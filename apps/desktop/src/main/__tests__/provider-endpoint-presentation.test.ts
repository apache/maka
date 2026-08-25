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
import test from 'node:test';
import { PROVIDER_DEFAULTS } from '@maka/core/llm-connections';
import {
  endpointCarriesCredentials,
  providerEndpointPresentation,
} from '../../renderer/settings/provider-endpoint-presentation.js';

// A 40-char hex-shaped run, built rather than written: long enough to trip
// the display redactor's long-opaque-token rule wherever it is left alone.
const longOpaqueToken = 'ab01'.repeat(10);

test('fixed Alibaba access paths expose their distinct effective endpoints read-only', () => {
  const api = providerEndpointPresentation({ providerType: 'alibaba' });
  const tokenPlanChina = providerEndpointPresentation({ providerType: 'alibaba-token-plan-cn' });

  assert.deepEqual(api, {
    value: PROVIDER_DEFAULTS.alibaba.baseUrl,
    editable: false,
    emptyState: 'missing',
  });
  assert.deepEqual(tokenPlanChina, {
    value: PROVIDER_DEFAULTS['alibaba-token-plan-cn'].baseUrl,
    editable: false,
    emptyState: 'missing',
  });
  assert.match(api.value!, /^https:\/\//);
  assert.match(tokenPlanChina.value!, /^https:\/\//);
  assert.notEqual(api.value, tokenPlanChina.value);
});

test('a persisted override is the displayed effective endpoint', () => {
  assert.deepEqual(
    providerEndpointPresentation({
      providerType: 'alibaba',
      baseUrl: '  https://relay.example.com/alibaba/v1/  ',
    }),
    {
      value: 'https://relay.example.com/alibaba/v1/',
      editable: false,
      emptyState: 'missing',
    },
  );
});

test('displaying a custom endpoint masks userinfo and every query value without hiding its route', () => {
  assert.deepEqual(
    providerEndpointPresentation({
      providerType: 'openai-compatible',
      baseUrl:
        `https://relay-user:relay-password@relay.example.com/v1?api-version=2026-08-01&api_key=${longOpaqueToken}`,
    }),
    {
      value:
        'https://<redacted>@relay.example.com/v1?api-version=<redacted>&api_key=<redacted>',
      editable: true,
      emptyState: 'missing',
    },
  );
});

test('query values are masked under arbitrary key names, not just known ones', () => {
  assert.deepEqual(
    providerEndpointPresentation({
      providerType: 'openai-compatible',
      baseUrl: `https://relay.example.com/v1?key=${longOpaqueToken}`,
    }),
    {
      value: 'https://relay.example.com/v1?key=<redacted>',
      editable: true,
      emptyState: 'missing',
    },
  );
  assert.deepEqual(
    providerEndpointPresentation({
      providerType: 'openai-compatible',
      baseUrl: `https://relay.example.com/v1?client_secret=${longOpaqueToken}`,
    }),
    {
      value: 'https://relay.example.com/v1?client_secret=<redacted>',
      editable: true,
      emptyState: 'missing',
    },
  );
});

test('custom relays and local runtimes retain endpoint editing', () => {
  assert.deepEqual(
    providerEndpointPresentation({
      providerType: 'openai-compatible',
      baseUrl: 'https://relay.example.com/v1',
    }),
    {
      value: 'https://relay.example.com/v1',
      editable: true,
      emptyState: 'missing',
    },
  );
  assert.deepEqual(
    providerEndpointPresentation({ providerType: 'ollama' }),
    {
      value: PROVIDER_DEFAULTS.ollama.baseUrl,
      editable: true,
      emptyState: 'missing',
    },
  );
});

test('derived and OAuth endpoints remain visible but read-only', () => {
  assert.deepEqual(
    providerEndpointPresentation({
      providerType: 'cloudflare-workers-ai',
      baseUrl: 'https://api.cloudflare.com/client/v4/accounts/example/ai/v1',
    }),
    {
      value: 'https://api.cloudflare.com/client/v4/accounts/example/ai/v1',
      editable: false,
      emptyState: 'missing',
    },
  );
  assert.deepEqual(
    providerEndpointPresentation({ providerType: 'openai-codex' }),
    {
      value: PROVIDER_DEFAULTS['openai-codex'].baseUrl,
      editable: false,
      emptyState: 'managed',
    },
  );
});

test('an absent custom endpoint remains visible as a missing editable value', () => {
  assert.deepEqual(
    providerEndpointPresentation({ providerType: 'openai-compatible' }),
    { value: null, editable: true, emptyState: 'missing' },
  );
});

test('providers with model-level endpoint overrides say so when showing the default', () => {
  // ZenMux routes Anthropic-family models through .../api/anthropic/v1 and
  // Cohere routes north-mini-code-1-0 through the compatibility endpoint, so
  // the connection-level default is not the whole truth for every model.
  assert.deepEqual(
    providerEndpointPresentation({ providerType: 'zenmux' }),
    {
      value: PROVIDER_DEFAULTS.zenmux.baseUrl,
      editable: false,
      emptyState: 'missing',
      modelOverrides: true,
    },
  );
  assert.deepEqual(
    providerEndpointPresentation({ providerType: 'cohere' }),
    {
      value: PROVIDER_DEFAULTS.cohere.baseUrl,
      editable: false,
      emptyState: 'missing',
      modelOverrides: true,
    },
  );
});

test('a configured endpoint wins over model overrides, so no caveat applies', () => {
  // resolveModelRuntime uses a configured baseUrl for every model; the row is
  // then the exact truth and must not carry the override note.
  assert.deepEqual(
    providerEndpointPresentation({
      providerType: 'zenmux',
      baseUrl: 'https://relay.example.com/v1',
    }),
    {
      value: 'https://relay.example.com/v1',
      editable: false,
      emptyState: 'missing',
    },
  );
});

test('endpointCarriesCredentials gates userinfo and query-bearing endpoints', () => {
  assert.equal(endpointCarriesCredentials('https://relay-user:relay-password@relay.example.com/v1'), true);
  assert.equal(endpointCarriesCredentials('https://relay.example.com/v1?api-version=2026-08-01'), true);
  assert.equal(endpointCarriesCredentials('https://relay.example.com/v1'), false);
  assert.equal(endpointCarriesCredentials(''), false);
  assert.equal(endpointCarriesCredentials(undefined), false);
  assert.equal(endpointCarriesCredentials('not a url'), false);
});
