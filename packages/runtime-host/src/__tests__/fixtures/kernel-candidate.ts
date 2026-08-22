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

import { parseInteractiveRuntimeHostCandidateArguments } from '../../candidate-cli.js';
import { defineInteractiveRuntimeHostComposition } from '../../server/host-composition.js';
import { createUnavailableDomainOperationHandlers } from '../../server/operation-dispatcher.js';
import { startInteractiveRuntimeHostCandidate } from '../../server/candidate.js';
import { runRuntimeHostProcessLifecycle } from '../../server/process-lifecycle.js';
import {
  candidateStartupFailureExitCode,
  classifyCandidateStartupFailure,
} from '../../candidate-startup-failure.js';

const composition = defineInteractiveRuntimeHostComposition(async () => ({
  handlers: createUnavailableDomainOperationHandlers(),
  beginDrain() {},
  async recover() {
    const code = process.env.MAKA_TEST_STARTUP_ERROR_CODE;
    if (!code) return;
    throw Object.assign(new Error('forced candidate startup failure'), { code });
  },
  async close() {},
}));
const options = parseInteractiveRuntimeHostCandidateArguments(process.argv.slice(2));
let result: Awaited<ReturnType<typeof startInteractiveRuntimeHostCandidate>>;
try {
  result = await startInteractiveRuntimeHostCandidate(options, composition);
} catch (error) {
  process.exit(candidateStartupFailureExitCode(classifyCandidateStartupFailure(error)));
}
if (result.kind === 'loser') process.exit(2);

try {
  await runRuntimeHostProcessLifecycle(result.host);
} catch {
  process.exitCode = 1;
}
