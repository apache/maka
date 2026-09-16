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
import { computerUseServiceHealth } from '../computer-use-host.js';
import { computerUseCapabilityReasons } from '../computer-use-capability-reasons.js';

describe('Computer Use capability row', () => {
  const none = (
    reason: 'unsupported_platform' | 'missing_executable' | 'backend_failed' | undefined,
  ) =>
    computerUseCapabilityReasons({
      backendId: 'none',
      health: computerUseServiceHealth('none', undefined, reason),
    });

  it('reports an unbound platform as a platform fact, not an integrity failure', () => {
    assert.deepEqual(none('unsupported_platform'), {
      feature: 'cu_platform_unsupported',
      probe: 'cu_platform_unsupported',
    });
  });

  it('keeps the three ways to have no backend apart', () => {
    const rows = [
      none('unsupported_platform'),
      none('missing_executable'),
      none('backend_failed'),
      none(undefined),
    ];
    assert.deepEqual(rows, [
      { feature: 'cu_platform_unsupported', probe: 'cu_platform_unsupported' },
      { feature: 'cu_executor_undistributable', probe: 'cu_executor_undistributable' },
      { feature: 'cu_backend_unavailable', probe: 'cu_backend_unavailable' },
      { feature: 'cu_executor_undistributable', probe: 'cu_executor_undistributable' },
    ]);
  });

  it('states the artifact reason only for a snapshot that never reached Computer Use', () => {
    assert.deepEqual(computerUseCapabilityReasons(undefined), {
      feature: 'cu_artifact_missing',
      probe: 'cu_backend_unavailable',
    });
  });

  it('reports the artifact and the probe separately while an executor is selected', () => {
    assert.deepEqual(
      computerUseCapabilityReasons({
        backendId: 'maka-cu',
        health: computerUseServiceHealth('maka-cu', {
          state: 'ready',
          generation: 1,
          restartAttempts: 0,
        }),
      }),
      { feature: 'cu_backend_status', probe: 'cu_executor_ready' },
    );
  });
});
