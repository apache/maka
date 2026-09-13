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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEV_LAUNCH_RESULT_FILE_ARG_PREFIX } from '@maka/core/dev-single-instance';
import { reportDevelopmentLaunchResult } from '../dev-single-instance-result.js';

test('the Electron lock owner publishes one private launch result', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maka-main-result-'));
  const resultFile = join(directory, 'launch-result.json');
  const argv = [`${DEV_LAUNCH_RESULT_FILE_ARG_PREFIX}${resultFile}`];
  try {
    assert.equal(reportDevelopmentLaunchResult(argv, { status: 'winner' }), true);
    assert.deepEqual(JSON.parse(readFileSync(resultFile, 'utf8')), {
      status: 'winner',
    });
    assert.equal(reportDevelopmentLaunchResult(argv, { status: 'loser' }), false);
    assert.deepEqual(JSON.parse(readFileSync(resultFile, 'utf8')), {
      status: 'winner',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
