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
import { getPlanModeCopy } from '../../renderer/locales/plan-mode-copy.js';

test('localizes Plan Mode chrome and abandon confirmation without rewriting plan content', () => {
  const zh = getPlanModeCopy('zh');
  const en = getPlanModeCopy('en');

  assert.equal(zh.proposal.statuses.approved, '已批准');
  assert.equal(en.proposal.statuses.approved, 'Approved');
  assert.equal(zh.execution.stepCount(2, 3), '2/3 步');
  assert.equal(en.execution.stepCount(1, 1), '1/1 step');
  assert.deepEqual(
    {
      title: en.abandonConfirmation.title,
      description: en.abandonConfirmation.description('Release plan'),
      confirm: en.abandonConfirmation.confirm,
    },
    {
      title: 'Abandon this plan?',
      description: 'The execution record for “Release plan” will remain, but it cannot be resumed.',
      confirm: 'Abandon plan',
    },
  );
});
