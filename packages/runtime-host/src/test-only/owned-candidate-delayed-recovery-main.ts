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
 * returns, so the remaining recovery time is part of any owner-loss exit
 * bound and has no kernel deadline. Delaying composition creation by a fixed
 * interval turns that window into a number the test controls (see
 * `OWNED_CANDIDATE_RECOVERY_DELAY_MS`) instead of however long an unassisted
 * recovery happens to take under load. The run still goes through the real
 * Runtime Host composition — only its start is deferred.
 */
import { runExecutionCandidateEntry } from '../candidate-entry.js';
import { createExecutionRuntimeHostComposition } from '../server/execution-composition.js';
import { OWNED_CANDIDATE_RECOVERY_DELAY_MS } from './owned-candidate-recovery-delay.js';

await runExecutionCandidateEntry(process.argv.slice(2), import.meta.url, {
  dependencies: {
    createComposition: async (context, compositionOptions) => {
      await new Promise((resolve) => setTimeout(resolve, OWNED_CANDIDATE_RECOVERY_DELAY_MS));
      return createExecutionRuntimeHostComposition(context, compositionOptions);
    },
  },
});
