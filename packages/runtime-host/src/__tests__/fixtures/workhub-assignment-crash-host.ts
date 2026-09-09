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

import type { BackendSendInput } from '@maka/core/backend-types';
import type { SessionEvent } from '@maka/core/events';
import { FakeBackend } from '@maka/runtime/test-only/fake-backend';
import { SqliteSessionMetadataStore } from '@maka/storage/sqlite-session-metadata-store';
import { startExecutionRuntimeHostCandidate } from '../../server/execution-candidate.js';
import { createExecutionRuntimeHostComposition } from '../../server/execution-composition.js';
import { runRuntimeHostProcessLifecycle } from '../../server/process-lifecycle.js';

const [rootPath, expectedRootId, mode] = process.argv.slice(2);
if (
  !rootPath ||
  !expectedRootId ||
  !['crash', 'recover', 'fail-assignment-once'].includes(mode ?? '')
) {
  throw new Error(
    'usage: workhub-assignment-crash-host <root> <root-id> <crash|recover|fail-assignment-once>',
  );
}

// Test-only barrier AFTER the real SQLite transaction, BEFORE its result reaches
// the leased facade and the Host can consume the target admission. No substitute
// store, production failpoint, graceful drain, or in-memory recovery is involved.
if (mode === 'crash') {
  const assign = SqliteSessionMetadataStore.prototype.assignWorkHubMessage;
  SqliteSessionMetadataStore.prototype.assignWorkHubMessage = async function (request) {
    const result = await assign.call(this, request);
    process.send?.({
      type: 'assignment_committed',
      assignment: result.assignment,
      admission: request.admission,
      targetCreated: result.targetCreated,
    });
    await new Promise<never>(() => undefined);
    return result;
  };
}

// Copying has already succeeded when this method is entered. A transient
// assignment failure must not strand that durable copy or poison a retry.
if (mode === 'fail-assignment-once') {
  const assign = SqliteSessionMetadataStore.prototype.assignWorkHubMessage;
  let failed = false;
  SqliteSessionMetadataStore.prototype.assignWorkHubMessage = async function (request) {
    if (!failed) {
      failed = true;
      process.send?.({ type: 'assignment_failed' });
      throw new Error('Injected failure after attachment copy, before assignment');
    }
    return assign.call(this, request);
  };
}

class ObservedBackend extends FakeBackend {
  override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    process.send?.({
      type: 'dispatch',
      sessionId: this.sessionId,
      turnId: input.turnId,
      text: input.text,
      attachments: input.attachments ?? [],
    });
    yield* super.send(input);
  }
}

const candidate = await startExecutionRuntimeHostCandidate(
  { rootPath, expectedRootId, idleGraceMs: 60_000 },
  {
    createComposition: (context, options) =>
      createExecutionRuntimeHostComposition(context, options, {
        primaryBackendFactory: (context) => new ObservedBackend(context),
      }),
  },
);
if (candidate.kind === 'loser') throw new Error('Fixture failed to acquire Host ownership');
process.on('message', (message) => {
  if (message && typeof message === 'object' && 'type' in message && message.type === 'shutdown') {
    void candidate.host.close();
  }
});
try {
  await runRuntimeHostProcessLifecycle(candidate.host, {
    closeOnDisconnect: true,
    onReady: () => process.send?.({ type: 'ready', hostEpoch: candidate.host.hostEpoch }),
  });
} finally {
  if (process.connected) process.disconnect?.();
}
