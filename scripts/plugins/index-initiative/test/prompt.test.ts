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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ASSISTANT_ROLE, PROACTIVE_TASK } from '../src/prompt.js';
test('proactive instructions match the approved text verbatim and retain the assistant contract', () => {
  assert.equal(
    createHash('sha256').update(PROACTIVE_TASK).digest('hex'),
    'c6a8895bdc0c6ed8a63c6d85fe76fadbf889f347061081ab46250472535b5654',
  );
  assert.match(ASSISTANT_ROLE, /没有索引也正常交流/);
  assert.match(ASSISTANT_ROLE, /只有转交工具成功后/);
  assert.match(ASSISTANT_ROLE, /另写记事本（用户明确要求的本地诊断记录除外）/);
});
