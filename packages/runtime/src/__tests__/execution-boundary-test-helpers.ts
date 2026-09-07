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

import { createExternalExecutionBoundary } from '@maka/core/sandbox-boundary';
import type { SessionEvent } from '@maka/core/events';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { StoredMessage } from '@maka/core/session';
import { DEFAULT_TOOL_MODE } from '@maka/core/tool-mode';
import {
  buildInvocationOpenedEvent,
  runtimeInvocationsFromSessionEvents,
} from '@maka/core/runtime-invocation';

import { AiSdkBackend, type AiSdkBackendInput } from '../ai-sdk-backend.js';
import {
  createSessionEventMapMemory,
  isLiveBackendSessionEvent,
  mapSessionEventToRuntimeEvent,
} from '../session-event-runtime-mapper.js';
import { projectRuntimeEventsToStoredMessages } from '../runtime-event-read-model.js';
import {
  createToolResultArchiveCapability,
  type ToolResultArchiveCapability,
  type ToolResultArchiveServices,
} from '../tool-result-archive-capability.js';
import { ToolRuntime, type ToolRuntimeInput } from '../tool-runtime.js';
import { ToolAuthorityRegistry } from '../preparation/tool-authority-registry.js';
import { ToolPreparationService } from '../preparation/tool-preparation-service.js';
import type { ModelProjectionTransition } from '@maka/core/model-projection-transition';

export const readExternalExecutionBoundary: AiSdkBackendInput['readExecutionBoundary'] = async () =>
  createExternalExecutionBoundary();

type TestAiSdkBackendInput = Omit<
  AiSdkBackendInput,
  'readExecutionBoundary' | 'preparationService'
> &
  Partial<Pick<AiSdkBackendInput, 'readExecutionBoundary' | 'preparationService'>> & {
    testProjectionArtifacts?: boolean;
    /**
     * The transcript this backend's turn produces, row by row as it appears.
     *
     * The backend writes no transcript: it emits SessionEvents, an AgentRun
     * maps them onto the ledger, and the read model projects the ledger back.
     * This runs that same path over the stream so a fixture can read the
     * transcript rows a turn yields without standing a whole Session up.
     */
    appendMessage?: (message: StoredMessage) => Promise<void>;
  };

type ProjectedTranscriptSink = (event: SessionEvent, turnId: string) => Promise<void>;

const projectedTranscripts = new WeakMap<AiSdkBackend, ProjectedTranscriptSink>();

/**
 * The transcript sink of a backend built with `appendMessage`, for a fixture
 * that drives the backend's tool runtime directly instead of through `send()`.
 */
export function projectedTranscriptOf(backend: AiSdkBackend): ProjectedTranscriptSink | undefined {
  return projectedTranscripts.get(backend);
}

/** Tee one live backend stream into projected transcript rows. */
function teeProjectedTranscript(
  backend: AiSdkBackend,
  sessionId: string,
  appendMessage: (message: StoredMessage) => Promise<void>,
): AiSdkBackend {
  const send = backend.send.bind(backend);
  const project = projectedTranscriptSink(sessionId, appendMessage);
  projectedTranscripts.set(backend, project);
  backend.send = async function* (sendInput) {
    for await (const event of send(sendInput) as AsyncIterable<SessionEvent>) {
      yield event;
      await project(event, sendInput.turnId);
    }
  } as AiSdkBackend['send'];
  return backend;
}

export function createTestAiSdkBackend(input: TestAiSdkBackendInput): AiSdkBackend {
  const { testProjectionArtifacts, appendMessage, ...backendInput } = input;
  const artifacts = new Map<string, Uint8Array>();
  let nextArtifactId = 0;
  // A whole transition ledger by default, for the same reason the archive
  // capability above is whole: a lossy model-history rewrite is only allowed
  // when it can be made durable, so a fixture without this seam would silently
  // disable pruning rather than exercise it (#4283).
  const transitions: ModelProjectionTransition[] = [];
  const backend = new AiSdkBackend({
    readExecutionBoundary: readExternalExecutionBoundary,
    preparationService: new ToolPreparationService(new ToolAuthorityRegistry()),
    loadModelProjectionTransitions: async () => ({
      transitions: [...transitions],
      unreadableTargets: new Set<string>(),
      unscopedUnreadable: 0,
    }),
    recordModelProjectionTransition: async (transition) => {
      transitions.push(transition);
    },
    providerStateIdentity: `sha256:${'1'.repeat(64)}`,
    ...backendInput,
    ...(testProjectionArtifacts
      ? {
          prepareDurableProjectionArtifact: ({ bytes }: { bytes: Uint8Array }) => {
            const relativePath = `artifact-${++nextArtifactId}`;
            const accepted = bytes.slice();
            return {
              ref: {
                kind: 'session_file' as const,
                sessionId: input.sessionId,
                relativePath,
              },
              persist: async () => {
                artifacts.set(relativePath, accepted);
              },
            };
          },
          readAttachmentBytes:
            input.readAttachmentBytes ??
            (async (ref) => {
              const bytes =
                ref.kind === 'session_file' ? artifacts.get(ref.relativePath) : undefined;
              return bytes
                ? { ok: true as const, bytes: bytes.slice() }
                : { ok: false as const, reason: 'not_found' as const };
            }),
        }
      : {}),
  });
  return appendMessage ? teeProjectedTranscript(backend, input.sessionId, appendMessage) : backend;
}

/**
 * An archive capability for tests whose subject is the writer or the replay
 * reader. The unexercised halves resolve to `not_found` rather than being
 * absent: a test may leave a road untravelled, but the capability itself is
 * still whole, which is the invariant these fixtures used to be able to break.
 */
export function testToolResultArchive(
  services: Partial<ToolResultArchiveServices>,
): ToolResultArchiveCapability {
  return createToolResultArchiveCapability({
    archiveToolResult: async () => undefined,
    readToolResultArchive: async () => ({ ok: false, reason: 'not_found' }),
    readArchivedToolResultResource: async () => ({ ok: false, reason: 'not_found' }),
    ...services,
  });
}

type TestToolRuntimeInput = Omit<ToolRuntimeInput, 'readExecutionBoundary' | 'turnId'> &
  Partial<Pick<ToolRuntimeInput, 'readExecutionBoundary' | 'turnId'>> & {
    /** The transcript rows this runtime's calls produce; see the backend helper. */
    appendMessage?: (message: StoredMessage) => Promise<void>;
  };

/** Defaults to the turn id nearly every ToolRuntime test already uses. */
export function createTestToolRuntime(input: TestToolRuntimeInput): ToolRuntime {
  const { appendMessage, ...runtimeInput } = input;
  const runtime = new ToolRuntime({
    readExecutionBoundary: readExternalExecutionBoundary,
    turnId: 'turn-1',
    ...runtimeInput,
  });
  if (!appendMessage) return runtime;
  const settleToolCall = runtime.settleToolCall.bind(runtime);
  const project = projectedTranscriptSink(input.sessionId, appendMessage);
  runtime.settleToolCall = (call) =>
    settleToolCall({
      ...call,
      eventSink: {
        push: (event) => {
          call.eventSink.push(event);
          void project(event, call.turnId);
        },
        pushAndWaitUntilConsumed: async (event) => {
          await call.eventSink.pushAndWaitUntilConsumed(event);
          await project(event, call.turnId);
        },
      },
    });
  return runtime;
}

/**
 * A stateful sink turning one live stream into projected transcript rows.
 *
 * Every row is derived by the production mapper and the production read model,
 * so what a fixture observes is what a reader of the ledger would see — not a
 * second copy written beside it.
 */
function projectedTranscriptSink(
  sessionId: string,
  appendMessage: (message: StoredMessage) => Promise<void>,
): (event: SessionEvent, turnId: string) => Promise<void> {
  const memory = createSessionEventMapMemory();
  const events: RuntimeEvent[] = [];
  let projected = 0;
  return async (event, turnId) => {
    if (!isLiveBackendSessionEvent(event)) return;
    const run = { sessionId, invocationId: turnId, runId: turnId, turnId };
    // Nothing projects without the invocation it belongs to. A fixture drives
    // the backend directly, so the opening fact an AgentRun would have
    // committed is stated here once, on the run's first event.
    if (events.length === 0) {
      events.push(
        buildInvocationOpenedEvent({
          id: `${turnId}-opened`,
          run,
          openedAt: event.ts,
          opening: {
            kind: 'invocation_opened',
            protocol: 'invocation_opened_v1',
            route: {
              provenance: 'unknown',
              backendKind: 'ai-sdk',
              llmConnectionSlug: 'test-connection',
              modelId: 'test-model',
            },
            configuration: {
              cwd: '/',
              permissionMode: 'bypass',
              collaborationMode: 'agent',
              orchestrationMode: 'default',
              orchestrationSource: 'session',
              toolMode: DEFAULT_TOOL_MODE,
            },
            root: { kind: 'user' },
            source: { kind: 'fresh' },
          },
        }),
      );
    }
    events.push(mapSessionEventToRuntimeEvent(event, run, memory));
    // Re-project the whole run: a row can only be completed by a later event
    // (a step's thinking pairs with the text row that follows it), so the
    // prefix is re-derived and only genuinely new rows are emitted.
    const messages = projectRuntimeEventsToStoredMessages(events, {
      invocations: runtimeInvocationsFromSessionEvents(sessionId, events),
    }).messages;
    for (const message of messages.slice(projected)) await appendMessage(message);
    projected = messages.length;
  };
}
