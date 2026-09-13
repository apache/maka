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

import type { SessionEvent } from '@maka/core/events';
import type { SessionSummary } from '@maka/core/session';
import {
  runMakaTextCliCore,
  type MakaRunContext,
  type MakaRunContextInput,
  type MakaRunRuntime,
} from '../run-command-core.js';

// Subprocess entry for the run-command process-contract tests: real piped
// stdin, SIGINT delivered by the operating system and observed as an exit
// code, and the fail-closed sandbox boundary reaching a non-interactive run.
// Ordinary command semantics are covered in process through the same adapter
// seam — keep this fixture limited to what a real child process is genuinely
// needed for.
const scenario = process.env.MAKA_RUN_FIXTURE_SCENARIO ?? 'echo';
let observer: MakaRunContextInput['runOutcomeObserver'];
let boundaryDenied = false;
let releaseStop: (() => void) | undefined;
let releaseGraphWait: (() => void) | undefined;

const summary: SessionSummary = {
  id: 'session-fixture',
  cwd: process.cwd(),
  name: 'fixture',
  isFlagged: false,
  isArchived: false,
  labels: [],
  hasUnread: false,
  status: 'active',
  backend: 'ai-sdk',
  llmConnectionSlug: 'fixture',
  connectionLocked: true,
  model: 'fixture-model',
  permissionMode: 'ask',
  collaborationMode: 'agent',
  orchestrationMode: 'default',
};

const runtime: MakaRunRuntime = {
  createSession: async () => summary,
  readExecutionBoundary: async () => ({ kind: 'managed', access: 'writable', revision: 0 }),
  setExecutionBoundaryKind: async () => {},
  async *sendMessage(_sessionId, input): AsyncIterable<SessionEvent> {
    if (scenario === 'sandbox-boundary') {
      yield {
        type: 'sandbox_boundary_request',
        id: 'event-boundary',
        turnId: input.turnId,
        ts: 1,
        requestId: 'boundary-1',
        toolUseId: 'tool-boundary',
        justification: 'Read an external file.',
        expansion: {
          filesystem: {
            entries: [{ path: '/outside/file.txt', access: 'read', scope: 'exact' }],
          },
        },
      };
      if (!boundaryDenied) throw new Error('sandbox boundary request was not denied');
      // A completed outcome with output makes the fail-closed exit code
      // load-bearing: only the boundary-failure classification may turn
      // this run into exit 1 with empty stdout.
      await observer?.({
        outcomeId: 'run-fixture',
        status: 'completed',
        finalOutput: 'should not be emitted',
        sandboxBoundary: 'none',
      });
      return;
    }
    if (scenario === 'graph-wait' && input.turnOrchestration?.mode !== 'graph') {
      throw new Error('expected graph orchestration');
    }
    if (scenario === 'slow') {
      // Ready is written only once the core has installed its SIGINT handler
      // (it registers before consuming this stream), so the test's signal
      // cannot race the default handler. The interval keeps the child alive
      // while it waits for the interrupt.
      process.stderr.write('fixture-ready\n');
      const keepAlive = setInterval(() => {}, 1_000);
      await new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
      clearInterval(keepAlive);
      return;
    }
    await observer?.({
      outcomeId: 'run-fixture',
      status: 'completed',
      finalOutput:
        scenario === 'graph-wait' ? 'initial graph supervisor output' : `prompt=${input.text}`,
      sandboxBoundary: 'none',
    });
  },
  respondToSandboxBoundary: async (_sessionId, response) => {
    boundaryDenied = response.decision === 'deny' && response.requestId === 'boundary-1';
  },
  stopSession: async () => {
    releaseStop?.();
  },
};

async function createContext(input: MakaRunContextInput): Promise<MakaRunContext> {
  observer = input.runOutcomeObserver;
  return {
    runtime,
    target: { connection: { slug: 'fixture' }, model: 'fixture-model' },
    ...(input.enableAgentGraph
      ? {
          agentGraph: {
            reserveActivity: () => ({ release: () => {} }),
            waitForCompletion: async () => {
              process.stderr.write('fixture-ready\n');
              const keepAlive = setInterval(() => {}, 1_000);
              await new Promise<void>((resolve) => {
                releaseGraphWait = resolve;
              });
              clearInterval(keepAlive);
            },
          },
        }
      : {}),
    close: async () => {
      releaseGraphWait?.();
    },
  };
}

runMakaTextCliCore(process.argv.slice(2), { createContext, listSessions: async () => [] }).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  },
);
