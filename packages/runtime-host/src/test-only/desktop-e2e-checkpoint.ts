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

import type { RuntimeEvent } from '@maka/core/runtime-event';
import {
  buildHistoryCompactCheckpoint,
  type HistoryCompactCheckpoint,
} from '@maka/runtime/history-compact-checkpoint';

export function createDesktopE2eCheckpoint(
  sessionId: string,
  coveredRuntimeEvents: readonly RuntimeEvent[],
): HistoryCompactCheckpoint {
  return buildHistoryCompactCheckpoint({
    sessionId,
    coveredRuntimeEvents,
    summary: [
      '## Goal',
      'Deterministic Desktop E2E context checkpoint.',
      '',
      '## Progress',
      '- deterministic compaction exercised',
      '',
      '## Next Steps',
      '1. continue',
      '',
      '## Critical Context',
      '- (none)',
    ].join('\n'),
  });
}
