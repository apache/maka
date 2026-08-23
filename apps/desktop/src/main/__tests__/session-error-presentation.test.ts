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

import { describeSessionErrorReason } from '../../renderer/session-error-presentation.js';
import { deriveFailedTurnRecovery, describeTurnErrorClass } from '../../renderer/session-status-presentation.js';

describe('provider capacity presentation', () => {
  it('uses capacity-specific copy instead of the unknown error fallback', () => {
    assert.match(describeSessionErrorReason('provider_capacity') ?? '', /满载/);
    assert.match(describeTurnErrorClass('provider_capacity'), /满载/);
  });

  it('does not recommend an immediate direct retry', () => {
    const recovery = deriveFailedTurnRecovery({
      errorClass: 'provider_capacity',
      partialOutputRetained: false,
      toolActivityCount: 0,
      erroredToolCount: 0,
    });
    assert.equal(recovery.action, 'retry');
    assert.match(recovery.label, /等待几分钟|切换模型/);
    assert.doesNotMatch(recovery.label, /直接重试/);
  });
});
