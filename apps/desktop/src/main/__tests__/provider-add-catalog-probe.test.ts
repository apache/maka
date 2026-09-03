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
import { test } from 'node:test';
import type { ConnectionCatalogProbeOutcome } from '../../shared/connection-catalog-probe.js';
import {
  catalogProbeChoices,
  catalogProbeRequest,
  runCatalogProbe,
  type CatalogProbeDraft,
} from '../../renderer/settings/provider-add-catalog-probe.js';

function draft(over: Partial<CatalogProbeDraft> = {}): CatalogProbeDraft {
  return {
    providerType: 'openai-compatible',
    baseUrl: 'https://relay.example.test/v1',
    apiKey: 'sk-relay',
    requestHeaders: [],
    ...over,
  };
}

test('refuses to probe before the form has an endpoint', () => {
  assert.equal(catalogProbeRequest(draft({ baseUrl: '   ' })), null);
  assert.equal(catalogProbeRequest(draft({ baseUrl: '' })), null);
});

test('trims the endpoint and passes a trimmed key, or none when the key is blank', () => {
  assert.deepEqual(
    catalogProbeRequest(draft({ baseUrl: '  https://relay.example.test/v1  ', apiKey: ' sk-relay ' })),
    {
      providerType: 'openai-compatible',
      baseUrl: 'https://relay.example.test/v1',
      apiKey: 'sk-relay',
    },
  );
  assert.deepEqual(catalogProbeRequest(draft({ apiKey: '   ' })), {
    providerType: 'openai-compatible',
    baseUrl: 'https://relay.example.test/v1',
    apiKey: null,
  });
});

test('carries the form request headers into the probe request', () => {
  assert.deepEqual(
    catalogProbeRequest(draft({
      requestHeaders: [
        { id: 1, name: 'X-Relay-Token', value: 'token-1', retained: false },
      ],
    })),
    {
      providerType: 'openai-compatible',
      baseUrl: 'https://relay.example.test/v1',
      apiKey: 'sk-relay',
      requestHeaders: [{ name: 'X-Relay-Token', value: 'token-1' }],
    },
  );
});

test('omits request headers when the draft has none', () => {
  assert.deepEqual(catalogProbeRequest(draft({ requestHeaders: [] })), {
    providerType: 'openai-compatible',
    baseUrl: 'https://relay.example.test/v1',
    apiKey: 'sk-relay',
  });
});

test('sends the request as the form drafted it and returns the host verdict', async () => {
  const outcome: ConnectionCatalogProbeOutcome = {
    kind: 'ready',
    models: [{ id: 'relay-model' }],
  };
  const probed = await runCatalogProbe(async (request) => {
    assert.deepEqual(request, catalogProbeRequest(draft()));
    return outcome;
  }, catalogProbeRequest(draft())!);
  assert.equal(probed, outcome);
});

test('turns a rejected IPC frame into a failed verdict instead of throwing', async () => {
  const probed = await runCatalogProbe(async () => {
    throw new Error('An endpoint is required to probe the model catalog');
  }, catalogProbeRequest(draft())!);
  assert.deepEqual(probed, { kind: 'failed', errorClass: 'unknown' });
});

test('offers the model id as both the chooser value and its label', () => {
  assert.deepEqual(
    catalogProbeChoices([
      { id: 'relay-model', contextWindow: 128_000 },
      { id: 'vision-model', displayName: 'Relay Vision' },
    ]),
    [{ value: 'relay-model', label: 'relay-model' }, { value: 'vision-model', label: 'vision-model' }],
  );
});
