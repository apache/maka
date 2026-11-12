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

import { startExecutionRuntimeHostCandidate } from '../../server/execution-candidate.js';
import { createExecutionRuntimeHostComposition } from '../../server/execution-composition.js';
import { runRuntimeHostProcessLifecycle } from '../../server/process-lifecycle.js';

const [rootPath, expectedRootId] = process.argv.slice(2);
if (!rootPath || !expectedRootId) throw new Error('Expected root path and identity');
// Production Host, AiSdk backend, Root authority and source adapters. Only title
// generation is disabled; the parent supplies a deterministic HTTP provider.
const candidate = await startExecutionRuntimeHostCandidate(
  { rootPath, expectedRootId, idleGraceMs: 60_000 },
  {
    createComposition: (context, options) =>
      createExecutionRuntimeHostComposition(
        context,
        { ...options, bootstrapRuntimePolicy: false },
        { generateSessionTitle: async () => undefined },
      ),
  },
);
if (candidate.kind === 'loser') throw new Error('Fixture did not acquire Host ownership');
process.on('message', (message: { type: string }) => {
  if (message.type === 'shutdown') void candidate.host.close();
});
try {
  await runRuntimeHostProcessLifecycle(candidate.host, {
    closeOnDisconnect: true,
    onReady: () => process.send?.({ type: 'ready', hostEpoch: candidate.host.hostEpoch }),
  });
} finally {
  if (process.connected) process.disconnect?.();
}
