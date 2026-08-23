#!/usr/bin/env node
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

/**
 * Desktop E2E candidate entry. It exists so the production entry
 * (`execution-candidate-main.ts`) carries no import of the E2E composition and
 * no `--desktop-e2e` branch: the entry file IS the switch, which is what keeps
 * FakeBackend and this bootstrap out of the release artifacts.
 *
 * The E2E run still goes through the real Runtime Host composition — only the
 * `primaryBackendFactory` seam is substituted.
 */
import { runExecutionCandidateEntry } from '../candidate-entry.js';
import {
  createDesktopE2eExecutionCandidateDependencies,
  DESKTOP_E2E_IDLE_GRACE_MS,
  watchDesktopE2eParentProcess,
} from './desktop-e2e-execution.js';

await runExecutionCandidateEntry(process.argv.slice(2), {
  overrideOptions: (options) => ({ ...options, idleGraceMs: DESKTOP_E2E_IDLE_GRACE_MS }),
  dependencies: createDesktopE2eExecutionCandidateDependencies(),
  onWon: (host) => watchDesktopE2eParentProcess(() => host.close()),
});
