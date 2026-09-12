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
 * Test-only Candidate entry for the owner-loss lifecycle tests. A
 * launch-owner Client is admitted while the Host is still recovering, and
 * the guard that closes the Host on owner loss binds only after startup
 * returns — so whether the test's kill lands before or after the bind is a
 * scheduling race a fixed sleep cannot decide. This entry instead gates
 * composition creation behind a release file: writing the stall marker
 * proves the Candidate is parked before the bind, the test kills the
 * launcher at that point, and releasing the gate afterwards lets startup
 * return promptly so the recorded loss closes the Host under the kernel's
 * `shutdownGraceMs`. The run still goes through the real Runtime Host
 * composition — only its start is held at the gate. The `onWon` hook adds
 * the second boundary the test needs: a marker written right after the
 * guard binds, so the exit budget starts at the bind rather than at the
 * release, which only unblocks startup.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runExecutionCandidateEntry } from '../candidate-entry.js';
import { createExecutionRuntimeHostComposition } from '../server/execution-composition.js';

const rootArgumentIndex = process.argv.indexOf('--root') + 1;
const rootPath = process.argv[rootArgumentIndex];
if (!rootPath) throw new Error('gated-recovery entry requires --root');
const stallMarker = join(dirname(rootPath), 'authority-lease-probe.stalled');
const releaseMarker = join(dirname(rootPath), 'authority-lease-probe.release');
const boundMarker = join(dirname(rootPath), 'authority-lease-probe.bound');

await runExecutionCandidateEntry(process.argv.slice(2), import.meta.url, {
  // `onWon` fires right after the launch-owner guard binds (candidate-entry
  // binds before invoking it), so this marker is the test's explicit
  // guard-bound boundary: the pre-bind recorded loss starts acting only past
  // it, which is where the exit budget under test actually begins.
  onWon: () => {
    writeFileSync(boundMarker, String(Date.now()));
    return () => undefined;
  },
  dependencies: {
    createComposition: async (context, compositionOptions) => {
      writeFileSync(stallMarker, String(Date.now()));
      while (!existsSync(releaseMarker)) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return createExecutionRuntimeHostComposition(context, compositionOptions);
    },
  },
});
