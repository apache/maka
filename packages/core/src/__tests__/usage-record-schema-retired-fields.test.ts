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
import { isContextBudgetDiagnostic } from '../usage-record-schema.js';
import type { ContextBudgetDiagnostic } from '../usage-stats/types.js';

const currentDiagnostic: ContextBudgetDiagnostic = {
  enabled: true,
  estimatedTokensBefore: 10,
  estimatedTokensAfter: 5,
  keptTurns: 1,
  droppedTurns: 1,
  keptEvents: 2,
  droppedEvents: 2,
};

// Retired telemetry remains readable but cannot be produced through the current contract.
const retiredDiagnostic: ContextBudgetDiagnostic = {
  ...currentDiagnostic,
  // @ts-expect-error semanticCompactEnabled is a decode-only historical key.
  semanticCompactEnabled: true,
};
void retiredDiagnostic;

test('accepts retired context-budget keys only as inert historical data', () => {
  assert.equal(
    isContextBudgetDiagnostic({
      ...currentDiagnostic,
      semanticCompactEnabled: true,
      synthesisCacheEnabled: true,
      historyCompactBlocksWritten: 1,
      historyRewriteVersion: 'legacy',
    }),
    true,
  );
  assert.equal(isContextBudgetDiagnostic({ ...currentDiagnostic, unknownFutureKey: true }), false);
});
