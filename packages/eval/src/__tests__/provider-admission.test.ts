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
import test from 'node:test';
import { isInferenceAdmissionEvent } from '../provider-admission.js';

test('recognizes confirmed provider inference events', () => {
  assert.equal(isInferenceAdmissionEvent({ type: 'response.created' }, false), true);
  assert.equal(
    isInferenceAdmissionEvent({ type: 'message_start', message: { id: 'msg' } }, true),
    true,
  );
  assert.equal(isInferenceAdmissionEvent({ choices: [{ delta: { content: 'x' } }] }, false), true);
  assert.equal(isInferenceAdmissionEvent({ usage: { input_tokens: 1 } }, false), true);
});

test('does not treat provider and transport errors as model admission', () => {
  assert.equal(isInferenceAdmissionEvent({ error: { type: 'rate_limit' } }, false), false);
  assert.equal(isInferenceAdmissionEvent({ type: 'response.failed' }, false), false);
  assert.equal(isInferenceAdmissionEvent({ type: 'ping' }, true), false);
});
