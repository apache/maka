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
import { resolveManualDiagnosticTarget } from '../../renderer/app-shell-command-actions.js';

test('targets manual diagnostics to the current task or new-task Host profile', () => {
  assert.deepEqual(
    resolveManualDiagnosticTarget(
      { navSection: 'sessions', sessionId: '["remote-host","session-1"]' },
      'new-task-profile',
    ),
    { sessionId: '["remote-host","session-1"]' },
  );
  assert.deepEqual(
    resolveManualDiagnosticTarget(
      { navSection: 'sessions', sessionId: undefined },
      'new-task-profile',
    ),
    { profileId: 'new-task-profile' },
  );
  assert.equal(
    resolveManualDiagnosticTarget(
      { navSection: 'extensions', sessionId: undefined },
      'new-task-profile',
    ),
    undefined,
  );
  assert.deepEqual(
    resolveManualDiagnosticTarget(
      { navSection: 'sessions', sessionId: '["hidden-host","hidden-session"]' },
      'hidden-new-task-profile',
      true,
      'settings-profile',
    ),
    { profileId: 'settings-profile' },
  );
  assert.equal(
    resolveManualDiagnosticTarget(
      { navSection: 'sessions', sessionId: '["hidden-host","hidden-session"]' },
      'hidden-new-task-profile',
      true,
    ),
    undefined,
  );
});
