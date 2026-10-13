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
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { isRetiredProvider, RETIRED_PROVIDER_TYPES } from '../provider-retirement.js';

describe('provider retirement', () => {
  it('owns the known retired providers', () => {
    assert.deepEqual(RETIRED_PROVIDER_TYPES, [
      'opencode-free',
      'commandcode-go',
      'claude-subscription',
    ]);
  });

  it('flags every retired provider type', () => {
    for (const type of RETIRED_PROVIDER_TYPES) {
      assert.equal(isRetiredProvider(type), true, type);
    }
  });

  it('does not flag an active provider', () => {
    assert.equal(isRetiredProvider('openai'), false);
  });

  it('does not flag an unknown provider (a stored connection can outlive the catalog)', () => {
    assert.equal(isRetiredProvider('some-future-provider'), false);
  });

  it('loads without runtime imports', () => {
    // Use a fresh process so an already-cached registry cannot hide a dependency.
    // Run against emitted JavaScript: type-only imports must have been erased.
    const moduleUrl = new URL('../provider-retirement.js', import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
          import { registerHooks } from 'node:module';
          const moduleUrl = process.argv[1];
          registerHooks({
            resolve(specifier, context, nextResolve) {
              if (context.parentURL === moduleUrl) {
                throw new Error('Unexpected retirement dependency: ' + specifier);
              }
              return nextResolve(specifier, context);
            },
          });
          await import(moduleUrl);
        `,
        moduleUrl,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  });
});
