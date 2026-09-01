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
import { join } from 'node:path';
import { describe, test } from 'node:test';

const workflowPath = join(import.meta.dirname, '../.github/workflows/asf-source-candidate.yml');
const ciWorkflowPath = join(import.meta.dirname, '../.github/workflows/ci.yml');

describe('ASF source workflow policy', () => {
  test('binds the candidate handoff to the dispatched commit and artifact', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    assert.doesNotMatch(workflow, /RELEASE_SHA/);
    assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
    assert.match(workflow, /--revision "\$GITHUB_SHA"/);
    assert.match(workflow, /Commit: \\`\$GITHUB_SHA\\`/);
    assert.match(workflow, /tar -xzf "\$CANDIDATE_PATH"/);
    assert.match(workflow, /npm run check:third-party-notices/);
    assert.match(workflow, /npm run check:cli-third-party-notices/);
    assert.match(workflow, /npm run check:windows-cargo-notices/);
    assert.doesNotMatch(workflow, /rc_number/);
    assert.match(workflow, /name: apache-maka-.*-incubating-\$\{\{ github\.sha \}\}-unsigned/);
    assert.match(workflow, /\$\{\{ env\.CANDIDATE_PATH \}\}\.sha512/);
    assert.match(
      workflow,
      /RUNBOOK_URL: .*\/blob\/\$\{\{ github\.sha \}\}\/\.github\/ASF_SOURCE_RELEASE\.md/,
    );
  });

  test('audits source headers in the extracted candidate before it is installed into', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const auditIndex = workflow.indexOf('npm run check:asf-headers');
    const installIndex = workflow.indexOf('npm ci');
    assert.notEqual(auditIndex, -1);
    assert.notEqual(installIndex, -1);
    assert.ok(
      auditIndex < installIndex,
      'the header audit must read the extracted archive, not a built tree',
    );
    assert.match(
      workflow,
      /Audit source headers in the extracted candidate\n\s+working-directory: candidate-source\n/,
    );
  });
});

describe('ASF source CI policy', () => {
  test('keeps the header audit install-free and runs generation checks after installation', () => {
    const workflow = readFileSync(ciWorkflowPath, 'utf8');
    const headerIndex = workflow.indexOf('name: Check ASF source headers');
    const installIndex = workflow.indexOf('name: Install dependencies');
    const sourceGateIndex = workflow.indexOf('name: Verify ASF source release mechanics');
    assert.notEqual(headerIndex, -1);
    assert.notEqual(installIndex, -1);
    assert.notEqual(sourceGateIndex, -1);
    assert.ok(headerIndex < installIndex);
    assert.ok(installIndex < sourceGateIndex);
    assert.match(
      workflow,
      /name: Install dependencies\n\s+if: .*steps\.plan\.outputs\.asf_source == 'true'/,
    );
  });
});
