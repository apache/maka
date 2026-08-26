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
import {
  WORKHUB_COORDINATION_SESSION_ID,
  WORKHUB_COORDINATION_SESSION_ROLE,
} from '@maka/core/session';
import {
  runtimeHostExecutionUnavailableReason,
  WORKHUB_COORDINATION_EXECUTION_UNAVAILABLE_REASON,
  WORKHUB_COORDINATION_TARGET_UNAVAILABLE_REASON,
} from '../server/host-session-availability.js';

const execution = {
  kind: 'workhub_coordination',
  inputDigest: `sha256:${'a'.repeat(64)}`,
} as const;
const base = {
  collaborationMode: 'agent' as const,
  orchestrationMode: 'default' as const,
  permissionMode: 'explore' as const,
  subagentWorkspace: undefined,
  transcriptLedgerVersion: 1 as const,
  toolProfile: 'workhub-coordination-v1' as const,
};

test('WorkHub execution requires the exact reserved id, role, and zero-tool profile', () => {
  assert.equal(
    runtimeHostExecutionUnavailableReason(
      {
        ...base,
        id: WORKHUB_COORDINATION_SESSION_ID,
        role: WORKHUB_COORDINATION_SESSION_ROLE,
      },
      execution,
    ),
    undefined,
  );
  assert.equal(
    runtimeHostExecutionUnavailableReason(
      {
        ...base,
        id: WORKHUB_COORDINATION_SESSION_ID,
        role: undefined,
      },
      execution,
    ),
    WORKHUB_COORDINATION_TARGET_UNAVAILABLE_REASON,
  );
  assert.equal(
    runtimeHostExecutionUnavailableReason(
      {
        ...base,
        id: 'ordinary-session',
        role: WORKHUB_COORDINATION_SESSION_ROLE,
      },
      execution,
    ),
    WORKHUB_COORDINATION_TARGET_UNAVAILABLE_REASON,
  );
  assert.equal(
    runtimeHostExecutionUnavailableReason(
      {
        ...base,
        id: WORKHUB_COORDINATION_SESSION_ID,
        role: WORKHUB_COORDINATION_SESSION_ROLE,
        toolProfile: undefined,
      },
      execution,
    ),
    WORKHUB_COORDINATION_EXECUTION_UNAVAILABLE_REASON,
  );
  assert.equal(
    runtimeHostExecutionUnavailableReason(
      {
        ...base,
        id: WORKHUB_COORDINATION_SESSION_ID,
        role: WORKHUB_COORDINATION_SESSION_ROLE,
        orchestrationMode: 'graph',
      },
      execution,
    ),
    WORKHUB_COORDINATION_EXECUTION_UNAVAILABLE_REASON,
  );
});
