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
import { linuxProcessStartTicks } from '../client/process-identity.js';

test('reads Linux process start time without interpreting hostile command text', () => {
  const stat =
    '42 (workspace --startup-attempt-id 00000000-0000-4000-8000-000000000001) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 98765 20';
  assert.equal(linuxProcessStartTicks(stat), '98765');
  assert.equal(linuxProcessStartTicks('42 malformed'), undefined);
});
