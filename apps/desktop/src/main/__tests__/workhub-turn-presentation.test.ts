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
import type { TurnViewModel } from '@maka/ui';
import { deriveWorkHubTurnPresentation } from '../../renderer/features/workhub/testing.js';

test('WorkHub enables the failure detail banner instead of showing only a failed status', () => {
  const failed: TurnViewModel = {
    turnId: 'turn-1',
    status: 'failed',
    errorClass: 'auth',
    failureMessage: 'The provider rejected the saved credential',
    tools: [],
    timeline: [],
    notes: [],
    startedAt: 1,
  };
  const presentation = deriveWorkHubTurnPresentation([failed], 'zh-CN');
  assert.match(presentation.failedReasonLabels['turn-1'] ?? '', /失败/);
  assert.equal(presentation.failedSeverities['turn-1'], 'error');
  assert.deepEqual(presentation.footerActionsByTurn, {});
});
