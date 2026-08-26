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

import { classifyEffort, countReadableLines, isUnreadPath, planLabels } from './pr-effort.mjs';

function file(filename, additions, deletions = 0) {
  return { filename, additions, deletions };
}

describe('isUnreadPath', () => {
  it('covers every lockfile format in the tree', () => {
    assert.equal(isUnreadPath('pnpm-lock.yaml'), true);
    assert.equal(isUnreadPath('package-lock.json'), true);
    assert.equal(isUnreadPath('native/runtime-host-peer/Cargo.lock'), true);
    assert.equal(isUnreadPath('native/gitoxide-helper/Cargo.lock'), true);
  });

  it('covers both spellings the notice generator emits', () => {
    assert.equal(isUnreadPath('apps/desktop/resources/licenses/npm/THIRD_PARTY_NOTICES.txt'), true);
    assert.equal(isUnreadPath('apps/desktop/src/renderer/public/THIRD_PARTY_LICENSES.txt'), true);
  });

  it('covers generated sources, snapshots and binaries', () => {
    assert.equal(isUnreadPath('packages/core/src/model-metadata.generated.ts'), true);
    assert.equal(isUnreadPath('scripts/model-metadata/models-dev-api.snapshot.json'), true);
    assert.equal(isUnreadPath('packages/storage/test-fixtures/v0.1.6/runtime.sqlite'), true);
    assert.equal(isUnreadPath('apps/desktop/build/background@2x.png'), true);
  });

  it('normalizes Windows separators', () => {
    assert.equal(isUnreadPath('native\\runtime-host-peer\\Cargo.lock'), true);
  });

  it('leaves hand-authored sources alone', () => {
    assert.equal(isUnreadPath('packages/cli/src/main.ts'), false);
    assert.equal(isUnreadPath('packages/core/test/session.test.ts'), false);
    assert.equal(isUnreadPath('apps/desktop/src/renderer/locales/mcp-copy.ts'), false);
    // Named for the notices but hand-written policy prose.
    assert.equal(isUnreadPath('docs/third-party-notices-policy.md'), false);
  });
});

describe('countReadableLines', () => {
  it('counts additions and deletions of reviewed files only', () => {
    const files = [
      file('packages/cli/src/main.ts', 20, 4),
      file('pnpm-lock.yaml', 9000, 8000),
      file('native/runtime-host-peer/Cargo.lock', 3524, 100),
      file('packages/core/src/model-metadata.generated.ts', 5000, 0),
      file('apps/desktop/src/renderer/public/THIRD_PARTY_LICENSES.txt', 900, 0),
    ];
    assert.equal(countReadableLines(files), 24);
  });

  it('does not discount test code, which is reviewed too', () => {
    assert.equal(countReadableLines([file('packages/core/test/session.test.ts', 300)]), 300);
  });

  it('treats an empty pull request as zero', () => {
    assert.equal(countReadableLines([]), 0);
  });
});

describe('classifyEffort', () => {
  it('places each tier on its inclusive upper bound', () => {
    assert.equal(classifyEffort([file('a.ts', 10)]).label, 'effort/XS');
    assert.equal(classifyEffort([file('a.ts', 11)]).label, 'effort/S');
    assert.equal(classifyEffort([file('a.ts', 100)]).label, 'effort/S');
    assert.equal(classifyEffort([file('a.ts', 101)]).label, 'effort/M');
    assert.equal(classifyEffort([file('a.ts', 500)]).label, 'effort/M');
    assert.equal(classifyEffort([file('a.ts', 501)]).label, 'effort/L');
    assert.equal(classifyEffort([file('a.ts', 1000)]).label, 'effort/L');
    assert.equal(classifyEffort([file('a.ts', 1001)]).label, 'effort/XL');
  });

  it('keeps a dependency bump at the tier its readable diff earns', () => {
    const bump = [file('pnpm-lock.yaml', 5000, 4000), file('package.json', 2, 2)];
    assert.equal(classifyEffort(bump).label, 'effort/XS');
  });

  it('reports the readable count alongside the tier', () => {
    assert.deepEqual(classifyEffort([file('a.ts', 40, 2)]), { label: 'effort/S', lines: 42 });
  });
});

describe('planLabels', () => {
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
