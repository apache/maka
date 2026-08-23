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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const workflow = readFileSync(
  resolve(import.meta.dirname, '../.github/workflows/asf-npm-candidate.yml'),
  'utf8',
);

test('ASF npm preflight validates the source RC package without publishing', () => {
  assert.match(workflow, /^permissions:\n  contents: read$/mu);
  assert.ok(workflow.includes('if [[ "$RELEASE_REPOSITORY" != "apache/maka" ]]'));
  assert.match(workflow, /RELEASE_REPOSITORY: \$\{\{ github\.repository \}\}/u);
  assert.match(workflow, /SOURCE_REFERENCE_TAG: \$\{\{ github\.ref_name \}\}/u);
  assert.ok(workflow.includes('if [[ "$RELEASE_REF" != "refs/tags/$SOURCE_REFERENCE_TAG" ]]'));
  assert.ok(workflow.includes('git cat-file -t "refs/tags/$SOURCE_REFERENCE_TAG"'));
  assert.ok(workflow.includes('git rev-parse "refs/tags/$SOURCE_REFERENCE_TAG^{commit}"'));
  assert.ok(workflow.includes('git merge-base --is-ancestor "$GITHUB_SHA" origin/main'));
  assert.match(workflow, /node scripts\/product-release-identity\.mjs/u);
  assert.match(
    workflow,
    /uses: \.\/\.github\/workflows\/cli-package-validation\.yml[\s\S]*?source_commit: \$\{\{ github\.sha \}\}/u,
  );
  assert.doesNotMatch(
    workflow,
    /id-token: write|npm (?:stage )?publish|npm dist-tag|download-artifact|\.sha512|asf-candidate\.json/u,
  );
});
