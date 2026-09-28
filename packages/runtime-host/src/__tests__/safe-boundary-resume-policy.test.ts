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
import { resolveSafeBoundaryResumePolicy } from '../server/safe-boundary-resume-policy.js';

test('enables interactive resume by default without enabling automated resume', () => {
  assert.deepEqual(resolveSafeBoundaryResumePolicy(undefined), {
    interactive: true,
    automated: false,
  });
  assert.deepEqual(resolveSafeBoundaryResumePolicy(''), {
    interactive: true,
    automated: false,
  });
});

test('preserves the existing explicit full opt-in', () => {
  for (const value of ['1', 'true']) {
    assert.deepEqual(resolveSafeBoundaryResumePolicy(value), {
      interactive: true,
      automated: true,
    });
  }
});

test('explicit disable and invalid values fail closed', () => {
  for (const value of ['0', 'false', 'unexpected']) {
    assert.deepEqual(resolveSafeBoundaryResumePolicy(value), {
      interactive: false,
      automated: false,
    });
  }
});
