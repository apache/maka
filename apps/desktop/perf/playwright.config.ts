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
 * Measurement harnesses that launch a real Electron window but do not belong
 * to the E2E tier. They seed hundreds of MiB and take minutes each, which is
 * worth paying when a number is in question and not worth paying on every
 * push, so nothing here runs in CI.
 *
 * Run from apps/desktop via `npm run measure`, which builds the app first.
 */
export default defineConfig({
  testDir: '.',
  workers: 1,
  captureGitInfo: { commit: false, diff: false },
  retries: 0,
  timeout: 2_400_000,
  expect: { timeout: 10_000 },
  outputDir: 'test-results',
  use: {
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
