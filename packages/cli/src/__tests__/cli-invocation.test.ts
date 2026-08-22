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
import { describe, test } from 'node:test';
import { formatMakaResumeCommand, formatMakaResumeHint } from '../cli-invocation.js';

describe('Maka CLI invocation copy', () => {
  test('keeps release resume instructions on the release launcher', () => {
    assert.equal(
      formatMakaResumeHint('maka', 'session-1'),
      'Resume this session with:\n  maka --resume session-1',
    );
  });

  test('keeps development remote and cwd retries on the development launcher', () => {
    assert.equal(
      formatMakaResumeHint('npm run cli:dev --', 'session-2', { hostProfileId: 'office' }),
      'Resume this session with:\n  npm run cli:dev -- --resume session-2 --host office',
    );
    assert.equal(
      formatMakaResumeCommand('npm run cli:dev --', 'session-2', { cwd: '<new-path>' }),
      'npm run cli:dev -- --resume session-2 --cwd <new-path>',
    );
  });
});
