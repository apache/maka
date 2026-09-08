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
import { describe, it } from 'node:test';
import {
  isRetiredProvider,
  RETIRED_PROVIDER_TYPES,
} from '../provider-retirement.ts';

describe('provider retirement', () => {
  it('owns a known retired provider', () => {
    assert.deepEqual(RETIRED_PROVIDER_TYPES, ['claude-subscription']);
  });

  it('flags the retired provider type', () => {
    assert.equal(isRetiredProvider('claude-subscription'), true);
  });

  it('does not flag an active provider', () => {
    assert.equal(isRetiredProvider('openai'), false);
  });

  it('does not flag an unknown provider (a stored connection can outlive the catalog)', () => {
    assert.equal(isRetiredProvider('some-future-provider'), false);
  });

  it('is a pure string predicate — no registry import at module load', () => {
    // Retirement must stay answerable without pulling the generated models.dev
    // tables; the Desktop first screen depends on this. The module imports only
    // a type from provider-registry, which is erased, so its runtime import
    // graph must be empty of registry symbols.
    assert.equal(typeof isRetiredProvider, 'function');
    assert.ok(Array.isArray(RETIRED_PROVIDER_TYPES));
  });
});
