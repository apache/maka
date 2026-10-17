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

import { parentPort, workerData } from 'node:worker_threads';
import {
  openColdRuntimeTranscriptStore,
  encodeRuntimePayloadJson,
  decodeRuntimePayloadJson,
} from '@maka/storage/cold-runtime-storage';
import type { CanonicalPermissionOutcomeRecord } from '@maka/runtime/interaction-authority';
import {
  createTranscriptProjection,
  projectTranscriptTurnLandmark,
  TRANSCRIPT_SOURCE_MAX_EVENTS,
  TRANSCRIPT_SOURCE_MAX_BYTES,
  TRANSCRIPT_SOURCE_MAX_RECORD_BYTES,
} from './session-transcript-reader.js';
import type {
  ProjectedTranscriptRun,
  TranscriptStorageJob,
} from './transcript-storage-worker-client.js';

const port = parentPort!;
let store: ReturnType<typeof openColdRuntimeTranscriptStore> | undefined;
let pending:
  | {
      job: TranscriptStorageJob;
      run: ProjectedTranscriptRun['run'];
      ordinals: [string, number][];
      projection: ReturnType<typeof createTranscriptProjection>;
    }
  | undefined;
const checkCancelled = (job: TranscriptStorageJob) => {
  if (Atomics.load(job.cancel, 0) !== 0) throw new Error('Storage read cancelled');
};
const fail = (id: number, error: unknown) =>
  port.postMessage({
    id,
    kind: 'result',
    error: {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : 'Storage worker failed',
    },
  });

port.on(
  'message',
  async (
    message:
      | TranscriptStorageJob
      | {
          id: number;
          kind: 'permissions';
          outcomes: ReadonlyMap<string, CanonicalPermissionOutcomeRecord>;
        }
      | { id: number; kind: 'permissions-error'; error: string },
  ) => {
    try {
      if (message.kind === 'permissions' || message.kind === 'permissions-error') {
        const state = pending;
        if (!state || state.job.id !== message.id)
          throw new Error('Unexpected storage permission reply');
        pending = undefined;
        checkCancelled(state.job);
        if (message.kind === 'permissions-error') throw new Error(message.error);
        const projected = state.projection.finishWithOutcomes(message.outcomes);
        port.postMessage({
          id: message.id,
          kind: 'result',
          value: {
            run: state.run,
            ordinals: state.ordinals,
            projected,
          } satisfies ProjectedTranscriptRun,
        });
        return;
      }
      checkCancelled(message);
      if (pending) throw new Error('Storage worker received overlapping jobs');
      if (message.kind === 'codec') {
        const value = message.values.map((json) => {
          checkCancelled(message);
          try {
            if (message.mode === 'encode') return encodeRuntimePayloadJson(json);
            const raw = decodeRuntimePayloadJson(json);
            return { json: raw };
          } catch (error) {
            return {
              json: null,
              error: error instanceof Error ? error.message : 'Invalid stored record',
            };
          }
        });
        port.postMessage({ id: message.id, kind: 'result', value });
        return;
      }
      store ??= openColdRuntimeTranscriptStore(workerData.databasePath);
      if (message.kind === 'recall') {
        const result = await store.listSessionsWithRuntimeEventText(
          message.sessionIds,
          message.terms,
        );
        checkCancelled(message);
        port.postMessage({ id: message.id, kind: 'result', value: result });
        return;
      }
      if (message.kind === 'landmarks') {
        const result = await store.projectTranscriptTurns(
          message.sessionId,
          message.request.turnId === null
            ? {
                throughOrdinal: message.request.throughOrdinal,
                limit: message.request.maxLandmarks,
              }
            : { turnId: message.request.turnId },
          (turn) => {
            checkCancelled(message);
            return projectTranscriptTurnLandmark(turn, message.request.turnId);
          },
        );
        checkCancelled(message);
        port.postMessage({
          id: message.id,
          kind: 'result',
          value: result.filter((value) => value !== null),
        });
        return;
      }
      const result = await store.readTranscriptRun(
        message.sessionId,
        {
          ...message.request,
          maxEvents: TRANSCRIPT_SOURCE_MAX_EVENTS,
          maxBytes: TRANSCRIPT_SOURCE_MAX_BYTES,
          maxRecordBytes: TRANSCRIPT_SOURCE_MAX_RECORD_BYTES,
        },
        (run, events) => {
          const projection = createTranscriptProjection([run.invocation]);
          const ordinals: [string, number][] = [];
          for (const { event, ordinal } of events) {
            checkCancelled(message);
            projection.push(event);
            ordinals.push([event.id, ordinal]);
          }
          checkCancelled(message);
          return { job: message, run, ordinals, projection };
        },
      );
      if (!result) {
        port.postMessage({ id: message.id, kind: 'result', value: undefined });
        return;
      }
      // readTranscriptRun has closed its SQLite snapshot before awaiting authority I/O.
      pending = result;
      port.postMessage({
        id: message.id,
        kind: 'permissions',
        ids: [...result.projection.permissionRequestIds()],
      });
    } catch (error) {
      pending = undefined;
      fail(message.id, error);
    }
  },
);

port.on('close', () => store?.close());
