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
import { petActivityForSession } from '../../renderer/custom-pet-companion-model.js';

test('the companion reads the displayed Session\'s activity and catalog row', () => {
  const idle = { turnRunning: false, awaitingInteraction: false };
  const at = (activity: typeof idle, sessionStatus?: 'active' | 'blocked' | 'waiting_for_user', hasActiveSession = true) =>
    petActivityForSession({ activity, hasActiveSession, sessionStatus });
  assert.equal(at(idle, 'active'), 'idle');
  assert.equal(at({ ...idle, turnRunning: true }, 'active'), 'working');
  assert.equal(at({ turnRunning: true, awaitingInteraction: true }, 'active'), 'needs-input', 'an open prompt outranks the running Turn');
  assert.equal(at(idle, 'waiting_for_user'), 'needs-input');
  assert.equal(at({ ...idle, turnRunning: true }, 'blocked'), 'blocked');
  assert.equal(at({ turnRunning: true, awaitingInteraction: true }, 'active', false), 'idle', 'no Session, no activity');
});
