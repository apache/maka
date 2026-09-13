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
import {
  DEV_CONFLICT_HANDLED_BY_LAUNCHER_FLAG,
  DEV_LAUNCH_RESULT_FILE_ARG_PREFIX,
  developmentLaunchResultFile,
  parseDevelopmentLaunchResult,
  shouldShowLoserDialog,
} from '../dev-single-instance.js';

test('shouldShowLoserDialog defaults to showing; the launcher flag silences', () => {
  assert.equal(shouldShowLoserDialog([]), true);
  assert.equal(shouldShowLoserDialog(['--no-sandbox']), true);
  assert.equal(shouldShowLoserDialog([DEV_CONFLICT_HANDLED_BY_LAUNCHER_FLAG]), false);
});

test('the last launcher-owned result argument selects the private result file', () => {
  assert.equal(developmentLaunchResultFile([]), undefined);
  assert.equal(developmentLaunchResultFile([DEV_LAUNCH_RESULT_FILE_ARG_PREFIX]), undefined);
  assert.equal(
    developmentLaunchResultFile([
      `${DEV_LAUNCH_RESULT_FILE_ARG_PREFIX}/tmp/untrusted.json`,
      `${DEV_LAUNCH_RESULT_FILE_ARG_PREFIX}/tmp/launch result.json`,
    ]),
    '/tmp/launch result.json',
  );
});

test('a winner verdict carries no process identity', () => {
  assert.deepEqual(parseDevelopmentLaunchResult('{"status":"winner"}\n'), {
    status: 'winner',
  });
});
