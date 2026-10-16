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

import { test, withE2eWindow } from '../e2e/fixtures';

// Run only when measuring a PR. The complete read is the pre-change path;
// the targeted read is the new path. This records actual Electron bridge and
// Host time, but has no injected network latency. The synthetic companion
// script covers 30 ms transport latency and Host request/byte counts.
for (const count of [100, 1_000, 5_000]) {
  test(`onboarding bridge read cost with ${count} Sessions`, async () => {
    await withE2eWindow({
      seed: true,
      onboardingPerfSessions: count,
      readinessSelector: '.maka-composer',
      readinessTimeoutMs: 300_000,
    }, async (page) => {
      const samples = await page.evaluate(async () => {
        const initial = await window.maka.onboarding.getSnapshot();
        const sessionId = initial.sessions[Math.floor(initial.sessions.length / 2)]?.id;
        if (!sessionId) throw new Error('Onboarding performance fixture has no Session');
        const sample = async (read: () => Promise<unknown>) => {
          const durations: number[] = [];
          let bytes = 0;
          for (let index = 0; index < 5; index += 1) {
            const start = performance.now();
            const result = await read();
            durations.push(performance.now() - start);
            bytes += new TextEncoder().encode(JSON.stringify(result)).byteLength;
          }
          durations.sort((a, b) => a - b);
          return { medianMs: durations[2], p95Ms: durations[4], bytesPerRead: bytes / 5 };
        };
        return {
          sessionCount: initial.sessions.length,
          full: await sample(() => window.maka.onboarding.getSnapshot()),
          targeted: await sample(() => window.maka.onboarding.getSessionUpdate(sessionId)),
        };
      });
      if (samples.sessionCount < count) {
        throw new Error(`Only ${samples.sessionCount} of ${count} seeded Sessions appeared`);
      }
      console.log(JSON.stringify({ kind: 'electron-onboarding', ...samples }));
    });
  });
}
