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

// Exercised through planLabels, the module's only export, so the tests bind to
// the contract the workflow calls rather than to helpers that would then exist
// only to be tested.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { planLabels } from './pr-effort.mjs';

function file(filename, additions, deletions = 0) {
  return { filename, additions, deletions };
}

function tier(files) {
  return planLabels(files).label;
}

function readable(files) {
  return planLabels(files).lines;
}

describe('tier boundaries', () => {
  it('places each tier on its inclusive upper bound', () => {
    assert.equal(tier([file('a.ts', 10)]), 'effort/XS');
    assert.equal(tier([file('a.ts', 11)]), 'effort/S');
    assert.equal(tier([file('a.ts', 100)]), 'effort/S');
    assert.equal(tier([file('a.ts', 101)]), 'effort/M');
    assert.equal(tier([file('a.ts', 500)]), 'effort/M');
    assert.equal(tier([file('a.ts', 501)]), 'effort/L');
    assert.equal(tier([file('a.ts', 1000)]), 'effort/L');
    assert.equal(tier([file('a.ts', 1001)]), 'effort/XL');
    assert.equal(tier([file('a.ts', 2500)]), 'effort/XL');
    assert.equal(tier([file('a.ts', 2501)]), 'effort/XXL');
  });

  it('counts additions and deletions together', () => {
    assert.equal(readable([file('a.ts', 40, 2)]), 42);
  });

  it('treats an empty pull request as the smallest tier', () => {
    assert.equal(tier([]), 'effort/XS');
  });
});

describe('unread paths', () => {
  it('excludes every lockfile format in the tree', () => {
    assert.equal(readable([file('pnpm-lock.yaml', 9000, 8000)]), 0);
    assert.equal(readable([file('package-lock.json', 9000)]), 0);
    assert.equal(readable([file('native/runtime-host-peer/Cargo.lock', 3524, 100)]), 0);
    assert.equal(readable([file('uv.lock', 500)]), 0);
  });

  it('excludes both spellings the notice generator emits', () => {
    assert.equal(
      readable([file('apps/desktop/resources/licenses/npm/THIRD_PARTY_NOTICES.txt', 900)]),
      0,
    );
    assert.equal(
      readable([file('apps/desktop/src/renderer/public/THIRD_PARTY_LICENSES.txt', 900)]),
      0,
    );
  });

  it('excludes generated sources, snapshots and binaries', () => {
    assert.equal(
      readable([file('packages/runtime/src/bundled-skill-catalog.generated.ts', 5000)]),
      0,
    );
    assert.equal(readable([file('scripts/model-metadata/models-dev-api.snapshot.json', 4000)]), 0);
    assert.equal(readable([file('packages/storage/test-fixtures/v0.1.6/runtime.sqlite', 1)]), 0);
    assert.equal(readable([file('apps/desktop/build/background@2x.png', 1)]), 0);
  });

  it('normalizes Windows separators', () => {
    assert.equal(readable([file('native\\runtime-host-peer\\Cargo.lock', 3524)]), 0);
  });

  it('keeps hand-authored sources, including tests and locale copy', () => {
    assert.equal(readable([file('packages/cli/src/main.ts', 20, 4)]), 24);
    assert.equal(readable([file('packages/core/test/session.test.ts', 300)]), 300);
    assert.equal(readable([file('apps/desktop/src/renderer/locales/mcp-copy.ts', 80)]), 80);
    // Named for the notices but hand-written policy prose.
    assert.equal(readable([file('docs/third-party-notices-policy.md', 40)]), 40);
  });

  it('keeps a dependency bump at the tier its readable diff earns', () => {
    assert.equal(
      tier([file('pnpm-lock.yaml', 5000, 4000), file('package.json', 2, 2)]),
      'effort/XS',
    );
  });
});

describe('label planning', () => {
  it('adds the tier and leaves unrelated labels alone', () => {
    const plan = planLabels([file('a.ts', 5)], ['bug', 'area/cli']);
    assert.deepEqual(plan.addLabels, ['effort/XS']);
    assert.deepEqual(plan.removeLabels, []);
  });

  it('replaces a tier the pull request has outgrown', () => {
    const plan = planLabels([file('a.ts', 2000)], ['effort/S', 'bug']);
    assert.deepEqual(plan.addLabels, ['effort/XL']);
    assert.deepEqual(plan.removeLabels, ['effort/S']);
  });

  it('collapses duplicate tiers left by an earlier run', () => {
    const plan = planLabels([file('a.ts', 5)], ['effort/XS', 'effort/M', 'effort/XL']);
    assert.deepEqual(plan.addLabels, []);
    assert.deepEqual(plan.removeLabels, ['effort/M', 'effort/XL']);
  });

  it('is idempotent once the tier already matches', () => {
    const plan = planLabels([file('a.ts', 5)], ['effort/XS']);
    assert.deepEqual(plan.addLabels, []);
    assert.deepEqual(plan.removeLabels, []);
  });
});
