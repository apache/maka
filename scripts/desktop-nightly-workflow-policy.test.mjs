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
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const workflowPath = new URL('../.github/workflows/desktop-nightly.yml', import.meta.url);

test('Nightly stays disabled until its external publishing authority is configured', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  assert.match(workflow, /if: vars\.DESKTOP_NIGHTLY_ENABLED == 'true'/u);
  assert.match(workflow, /test "\$GITHUB_REPOSITORY" = apache\/maka/u);
  assert.match(workflow, /test "\$GITHUB_REF" = refs\/heads\/main/u);
  assert.doesNotMatch(workflow, /source_reference_tag|incubating|contents: write/u);
});

test('Nightly verifies provenance and advances mutable feeds only after payload upload', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const attest = workflow.indexOf('name: Attest the exact Nightly payloads');
  const verify = workflow.indexOf('name: Verify the issued Nightly provenance');
  const payloads = workflow.indexOf('name: Publish immutable Nightly payloads');
  const feed = workflow.indexOf('name: Advance the Nightly update feed last');

  assert.ok(attest >= 0 && verify > attest && payloads > verify && feed > payloads);
  assert.match(workflow, /\.github\/workflows\/desktop-nightly\.yml@refs\/heads\/main/u);
  assert.match(workflow, /gh attestation verify/u);
  assert.match(workflow, /NIGHTLIES_RSYNC_PATH/u);
  assert.match(workflow, /switches: -rlptDvz --delete/u);
});
