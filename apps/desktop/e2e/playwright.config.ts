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

import { defineConfig } from '@playwright/test';

/**
 * Playwright config for the desktop Electron E2E suite.
 *
 * Every test launches a real Electron window backed by the deterministic fake
 * backend (MAKA_E2E=1) against its OWN throwaway userData dir. One worker,
 * everywhere: what is left in this tier is here because it needs a native
 * window, and concurrent windows share OS focus, which invalidates exactly the
 * focus, pointer and geometry contracts that kept these tests here.
 * Deliberately no test count here — the previous note carried a stale one that
 * outlived two rounds of pruning. `playwright test --list` is the only figure
 * that cannot rot.
 *
 * Run from apps/desktop via `npm run e2e`, which builds the app first.
 */
export default defineConfig({
  testDir: '.',
  workers: 1,
  // CI publishes no Playwright report that consumes Git metadata. Disable its
  // best-effort shallow-history fetch, which otherwise waits on a fixed timeout.
  captureGitInfo: { commit: false, diff: false },
  // No retries: flakes should fail loudly. The fixture waits for the composer
  // to mount (the cold-start convergence point — connection seed, onboarding
  // clear, renderer hydrated), so cold-start variance never reaches the test.
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: 'test-results',
  use: {
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
