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
import { RuntimeHostProtocolError } from '../protocol/errors.js';
import {
  decodeWorkHubCoordinationResolveInput,
  decodeWorkHubCoordinationResolveResult,
  HOST_OPERATION_SPECS,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
} from '../protocol/index.js';

test('WorkHub Coordination resolve has a closed empty input and bounded identity result', () => {
  assert.deepEqual(decodeWorkHubCoordinationResolveInput({}), {});
  assert.deepEqual(decodeWorkHubCoordinationResolveResult({ sessionId: 'coordination' }), {
    sessionId: 'coordination',
  });
  assert.equal(HOST_OPERATION_SPECS['workhub.coordination.resolve'].mode, 'command');
  assert.ok(RUNTIME_HOST_COMPATIBILITY_EPOCH > 48);
  assert.throws(
    () => decodeWorkHubCoordinationResolveInput({ sessionId: 'caller-selected' }),
    (error) => error instanceof RuntimeHostProtocolError,
  );
  assert.throws(
    () => decodeWorkHubCoordinationResolveResult({ sessionId: 'coordination', role: 'injected' }),
    (error) => error instanceof RuntimeHostProtocolError,
  );
});
