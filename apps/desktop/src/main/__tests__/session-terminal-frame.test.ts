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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  scheduleTerminalFrame,
  type TerminalAnimationFrameEnvironment,
} from '../../renderer/features/workbar/testing.js';

describe('Session Terminal animation frame lifecycle', () => {
  it('cancels and suppresses a frame that arrives after cleanup', () => {
    let scheduled: FrameRequestCallback | undefined;
    const canceled: number[] = [];
    const environment: TerminalAnimationFrameEnvironment = {
      request: (callback) => {
        scheduled = callback;
        return 17;
      },
      cancel: (frame) => canceled.push(frame),
    };
    let runs = 0;

    const cleanup = scheduleTerminalFrame(() => {
      runs += 1;
    }, environment);

    cleanup();
    assert.deepEqual(canceled, [17]);
    scheduled?.(0);
    assert.equal(runs, 0);

    cleanup();
    assert.deepEqual(canceled, [17]);
  });
});
