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
import { canonicalizeLegacyPlanReminderCronExpression } from '../legacy-cron-expression.js';

test('converts released single-value steps without changing wildcard steps', () => {
  assert.equal(canonicalizeLegacyPlanReminderCronExpression('5/10 * * * *'), '5 * * * *');
  assert.equal(canonicalizeLegacyPlanReminderCronExpression('*/5 * * * *'), '*/5 * * * *');
});

test('rejects a source expression outside the released grammar', () => {
  assert.throws(() => canonicalizeLegacyPlanReminderCronExpression('0 0 30 2 *'));
});
