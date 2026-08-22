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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionEvent } from '@maka/core/events';
import {
  armLiveTurn,
  ChatSurfaceLayout,
  ChatView,
  LocaleProvider,
  type LiveTurnProjection,
  type InteractionQueues,
} from '@maka/ui';
import {
  createAppShellSessionDisplayBatch,
  createAppShellSessionEventHandlers,
} from '../../renderer/app-shell-session-events.js';

function renderWithLocale(child: ReactNode): string {
  return renderToStaticMarkup(
    createElement(LocaleProvider, {
      locale: 'zh',
      children: createElement(ChatSurfaceLayout, { composer: null, children: child }),
    }),
  );
}

function createStateSetter<T>(initial: T): {
  get(): T;
  set(updater: (current: T) => T): void;
} {
  let value = initial;
  return {
    get: () => value,
    set: (updater) => {
      value = updater(value);
    },
  };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function renderLiveTurn(liveTurn: LiveTurnProjection): string {
  return renderWithLocale(createElement(ChatView, {
    activeSession: {
      id: 'session-1',
      name: 'streaming',
      lastMessageAt: 1,
      status: 'active',
      backend: 'ai-sdk',
      labels: [],
      isFlagged: false,
      isArchived: false,
      hasUnread: false,
      llmConnectionSlug: 'conn',
      connectionLocked: false,
      model: 'model',
      permissionMode: 'ask',
    },
    messages: [{ type: 'user', id: 'user-1', turnId: liveTurn.turnId, ts: 1, text: 'go' }],
    scrollBehavior: 'smooth',
    liveTurn,
    onNew() {},
  } satisfies Parameters<typeof ChatView>[0]));
}

describe('single live-turn handoff', () => {
  it('renders one ordered timeline: thinking before its tool and answer', () => {
    const markup = renderLiveTurn({
      turnId: 'turn-1',
      phase: 'streamed',
      steps: [{
        stepId: 'assistant-1',
        thinking: { text: '先检查', truncated: false, complete: false },
        text: { text: '最终答案', truncated: false, complete: true },
        tools: [{
          toolUseId: 'tool-1',
          toolName: 'Bash',
          stepId: 'assistant-1',
          status: 'running',
          args: {},
          result: { kind: 'text', text: 'ok' },
        }],
      }],
    });

    // Thinking and tools own their disclosures; do not wrap them in another.
    assert.equal((markup.match(/maka-processing-block/g) ?? []).length, 0);
    assert.ok(markup.indexOf('深度思考') >= 0);
    assert.ok(markup.indexOf('深度思考') < markup.indexOf('最终答案'));
    assert.ok(markup.indexOf('最终答案') < markup.indexOf('Bash'));
    assert.equal((markup.match(/data-turn-id=/g) ?? []).length, 1);
  });

  it('keeps a completed live answer as the only visible owner until settle', () => {
    const finalText = 'one visible answer';
    const markup = renderWithLocale(createElement(ChatView, {
      activeSession: {
        id: 'session-1', name: 'streaming', lastMessageAt: 1, status: 'active', backend: 'ai-sdk',
        labels: [], isFlagged: false, isArchived: false, hasUnread: false,
        llmConnectionSlug: 'conn', connectionLocked: false, model: 'model', permissionMode: 'ask',
      },
      messages: [
        { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'go' },
        { type: 'assistant', id: 'assistant-1', turnId: 'turn-1', ts: 2, text: finalText, modelId: 'model' },
      ],
      scrollBehavior: 'smooth',
      liveTurn: {
        turnId: 'turn-1',
        phase: 'streamed',
        terminal: true,
        steps: [{
          stepId: 'assistant-1',
          text: { text: finalText, truncated: false, complete: true },
          tools: [],
        }],
      },
      onNew() {},
    } satisfies Parameters<typeof ChatView>[0]));

    assert.match(markup, /maka-bubble-streaming/);
    assert.equal(markup.split(finalText).length - 1, 1);
  });

  it('keeps an incomplete live answer as the only owner after early persistence', () => {
    const text = 'persisted before a slow tool finishes';
    const markup = renderWithLocale(createElement(ChatView, {
      activeSession: {
        id: 'session-1', name: 'streaming', lastMessageAt: 1, status: 'running', backend: 'ai-sdk',
        labels: [], isFlagged: false, isArchived: false, hasUnread: false,
        llmConnectionSlug: 'conn', connectionLocked: false, model: 'model', permissionMode: 'ask',
      },
      messages: [
        { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'go' },
        { type: 'assistant', id: 'assistant-1', turnId: 'turn-1', ts: 2, text, modelId: 'model' },
      ],
      scrollBehavior: 'smooth',
      liveTurn: {
        turnId: 'turn-1',
        phase: 'streamed',
        steps: [{
          stepId: 'assistant-1',
          text: { text, truncated: false, complete: false },
          tools: [{ toolUseId: 'tool-1', toolName: 'Bash', stepId: 'assistant-1', status: 'running', args: {} }],
        }],
      },
      onNew() {},
    } satisfies Parameters<typeof ChatView>[0]));

    assert.equal((markup.match(/maka-bubble-streaming/g) ?? []).length, 1);
    assert.equal(markup.split(text).length - 1, 0);
  });

  it('hands terminal streamed text to committed history without waiting for a render callback', async () => {
    const liveTurns = createStateSetter<Record<string, LiveTurnProjection>>({
      'session-1': armLiveTurn('turn-1'),
    });
    const liveTurnBySessionRef = { current: liveTurns.get() };
    const interactions = createStateSetter<InteractionQueues>({});
    const refreshes: Array<{ sessionId: string; required?: string }> = [];
    const setLiveTurnBySession = (updater: (current: Record<string, LiveTurnProjection>) => Record<string, LiveTurnProjection>) => {
      liveTurns.set(updater);
      liveTurnBySessionRef.current = liveTurns.get();
    };
    const handlers = createAppShellSessionEventHandlers({
      uiLocale: 'zh',
      activeIdRef: { current: 'session-1' },
      liveTurnBySessionRef,
      refreshMessages: async (sessionId, options) => {
        refreshes.push({ sessionId, required: options?.requiredAssistantMessageId });
        return refreshes.length >= 3;
      },
      refreshSessions: async () => [],
      setLiveTurnBySession,
      setInteractionBySession: interactions.set,
      showModelSetupToast: () => {},
      toastApi: { error: () => {} },
    });

    const emit = (event: SessionEvent) => handlers.handleEvent('session-1', event);
    emit({
      type: 'thinking_delta', id: 'e1', turnId: 'turn-1', messageId: 'assistant-1', ts: 1, text: '思考',
    });
    emit({
      type: 'tool_start', id: 'e2', turnId: 'turn-1', stepId: 'assistant-1', ts: 2,
      toolUseId: 'tool-1', toolName: 'Bash', args: {},
    });
    emit({
      type: 'text_complete', id: 'e3', turnId: 'turn-1', messageId: 'assistant-1', ts: 3, text: '答案',
    });
    emit({ type: 'complete', id: 'e4', turnId: 'turn-1', ts: 4, stopReason: 'end_turn' });

    const terminal = liveTurns.get()['session-1'];
    assert.equal(terminal?.terminal, true);
    assert.deepEqual(terminal?.steps[0]?.thinking?.text, '思考');
    assert.equal(terminal?.steps[0]?.tools[0]?.toolUseId, 'tool-1');
    assert.equal(terminal?.steps[0]?.text?.text, '答案');

    await waitFor(
      () => liveTurns.get()['session-1'] === undefined,
      'Timed out waiting for the durable transcript handoff',
    );
    assert.equal(liveTurns.get()['session-1'], undefined);
    assert.equal(
      refreshes.filter((call) => call.required === 'assistant-1').length,
      3,
    );
  });

  it('publishes visible deltas at most once per animation frame', () => {
    const liveTurns = createStateSetter<Record<string, LiveTurnProjection>>({
      'session-1': armLiveTurn('turn-1'),
    });
    const liveTurnBySessionRef = { current: liveTurns.get() };
    const interactions = createStateSetter<InteractionQueues>({});
    const frames: Array<() => void> = [];
    let publications = 0;
    const handlers = createAppShellSessionEventHandlers({
      uiLocale: 'zh',
      activeIdRef: { current: 'session-1' },
      liveTurnBySessionRef,
      refreshMessages: async () => true,
      refreshSessions: async () => [],
      setLiveTurnBySession: (updater) => {
        publications += 1;
        liveTurns.set(updater);
        liveTurnBySessionRef.current = liveTurns.get();
      },
      setInteractionBySession: interactions.set,
      showModelSetupToast: () => {},
      toastApi: { error: () => {} },
      scheduleFrame: (callback) => { frames.push(callback); },
    });

    for (let index = 0; index < 100; index += 1) {
      handlers.handleEvent('session-1', {
        type: 'text_delta',
        id: `event-${index}`,
        turnId: 'turn-1',
        messageId: 'assistant-1',
        ts: index,
        text: 'x',
      });
    }
    assert.equal(publications, 0);
    assert.equal(frames.length, 1);
    frames.shift()?.();
    assert.equal(publications, 1);
    assert.equal(liveTurns.get()['session-1']?.steps[0]?.text?.text, 'x'.repeat(100));

    handlers.handleEvent('session-1', {
      type: 'text_delta', id: 'event-100', turnId: 'turn-1', messageId: 'assistant-1', ts: 100, text: 'y',
    });
    handlers.handleEvent('session-1', {
      type: 'text_complete', id: 'event-101', turnId: 'turn-1', messageId: 'assistant-1', ts: 101, text: 'done',
    });
    assert.equal(publications, 2);
    assert.equal(liveTurns.get()['session-1']?.steps[0]?.text?.text, 'done');
    frames.shift()?.();
    assert.equal(publications, 2);
  });

  it('applies catch-up deltas immediately until the returning session is seeded', () => {
    const liveTurns = createStateSetter<Record<string, LiveTurnProjection>>({
      'session-1': armLiveTurn('turn-1'),
    });
    const liveTurnBySessionRef = { current: liveTurns.get() };
    const interactions = createStateSetter<InteractionQueues>({});
    const frames: Array<() => void> = [];
    let publications = 0;
    const handlers = createAppShellSessionEventHandlers({
      uiLocale: 'zh',
      activeIdRef: { current: 'session-1' },
      liveTurnBySessionRef,
      refreshMessages: async () => true,
      refreshSessions: async () => [],
      setLiveTurnBySession: (updater) => {
        publications += 1;
        liveTurns.set(updater);
        liveTurnBySessionRef.current = liveTurns.get();
      },
      setInteractionBySession: interactions.set,
      showModelSetupToast: () => {},
      toastApi: { error: () => {} },
      scheduleFrame: (callback) => { frames.push(callback); },
    });

    handlers.markDisplayPending('session-1');
    handlers.handleEvent('session-1', {
      type: 'text_delta',
      id: 'seed',
      turnId: 'turn-1',
      messageId: 'assistant-1',
      ts: 1,
      startOffset: 0,
      text: 'prefix accumulated while away',
    });
    assert.equal(publications, 1);
    assert.equal(frames.length, 0);
    assert.equal(
      liveTurns.get()['session-1']?.steps[0]?.text?.text,
      'prefix accumulated while away',
    );

    handlers.flushDisplayEvents('session-1');
    handlers.markDisplayReady('session-1');
    handlers.handleEvent('session-1', {
      type: 'text_delta',
      id: 'live',
      turnId: 'turn-1',
      messageId: 'assistant-1',
      ts: 2,
      text: ' new',
    });
    assert.equal(publications, 1);
    assert.equal(frames.length, 1);
    frames.shift()?.();
    assert.equal(publications, 2);
    assert.equal(
      liveTurns.get()['session-1']?.steps[0]?.text?.text,
      'prefix accumulated while away new',
    );
  });

  it('shares pending display events across handler replacement', () => {
    const liveTurns = createStateSetter<Record<string, LiveTurnProjection>>({
      'session-1': armLiveTurn('turn-1'),
    });
    const liveTurnBySessionRef = { current: liveTurns.get() };
    const interactions = createStateSetter<InteractionQueues>({});
    const frames: Array<() => void> = [];
    const displayBatch = createAppShellSessionDisplayBatch();
    let publications = 0;
    const deps = {
      uiLocale: 'zh' as const,
      activeIdRef: { current: 'session-1' },
      liveTurnBySessionRef,
      refreshMessages: async () => true,
      refreshSessions: async () => [],
      setLiveTurnBySession: (updater: (current: Record<string, LiveTurnProjection>) => Record<string, LiveTurnProjection>) => {
        publications += 1;
        liveTurns.set(updater);
        liveTurnBySessionRef.current = liveTurns.get();
      },
      setInteractionBySession: interactions.set,
      showModelSetupToast: () => {},
      toastApi: { error: () => {} },
      scheduleFrame: (callback: () => void) => { frames.push(callback); },
      displayBatch,
    };
    const beforeRender = createAppShellSessionEventHandlers(deps);
    beforeRender.handleEvent('session-1', {
      type: 'text_delta', id: 'delta', turnId: 'turn-1', messageId: 'assistant-1', ts: 1,
      text: 'partial',
    });

    const afterRender = createAppShellSessionEventHandlers(deps);
    afterRender.handleEvent('session-1', {
      type: 'text_complete', id: 'complete', turnId: 'turn-1', messageId: 'assistant-1', ts: 2,
      text: 'done',
    });
    assert.equal(liveTurns.get()['session-1']?.steps[0]?.text?.text, 'done');
    assert.equal(liveTurns.get()['session-1']?.steps[0]?.text?.complete, true);

    frames.shift()?.();
    assert.equal(publications, 1);
    assert.equal(liveTurns.get()['session-1']?.steps[0]?.text?.text, 'done');
    assert.equal(liveTurns.get()['session-1']?.steps[0]?.text?.complete, true);
  });

  it('queues a sandbox boundary request without ending the live turn', () => {
    const liveTurns = createStateSetter<Record<string, LiveTurnProjection>>({
      'session-1': armLiveTurn('turn-1'),
    });
    const ref = { current: liveTurns.get() };
    const interactions = createStateSetter<InteractionQueues>({});
    const setLiveTurnBySession = (updater: (current: Record<string, LiveTurnProjection>) => Record<string, LiveTurnProjection>) => {
      liveTurns.set(updater);
      ref.current = liveTurns.get();
    };
    const handlers = createAppShellSessionEventHandlers({
      uiLocale: 'zh',
      activeIdRef: { current: 'session-1' },
      liveTurnBySessionRef: ref,
      refreshMessages: async () => true,
      refreshSessions: async () => [],
      setLiveTurnBySession,
      setInteractionBySession: interactions.set,
      showModelSetupToast: () => {},
      toastApi: { error: () => {} },
    });

    handlers.handleEvent('session-1', {
      type: 'sandbox_boundary_request',
      id: 'e1',
      turnId: 'turn-1',
      ts: 1,
      requestId: 'request-1',
      toolUseId: 'tool-1',
      justification: 'Write the requested export.',
      expansion: {
        filesystem: {
          entries: [{ path: '/tmp/export.txt', access: 'write', scope: 'exact' }],
        },
      },
    });

    assert.equal(liveTurns.get()['session-1']?.terminal, undefined);
    assert.equal(interactions.get()['session-1']?.[0]?.requestId, 'request-1');
  });

  it('hands an aborted projection over only after persisted messages cover it', async () => {
    const liveTurns = createStateSetter<Record<string, LiveTurnProjection>>({
      'session-1': {
        turnId: 'turn-1',
        phase: 'streamed',
        steps: [{
          stepId: 'step-1',
          tools: [{
            toolUseId: 'tool-1',
            toolName: 'Bash',
            status: 'running',
            args: {},
          }],
        }],
      },
    });
    const ref = { current: liveTurns.get() };
    const interactions = createStateSetter<InteractionQueues>({});
    const setLiveTurnBySession = (updater: (current: Record<string, LiveTurnProjection>) => Record<string, LiveTurnProjection>) => {
      liveTurns.set(updater);
      ref.current = liveTurns.get();
    };
    let resolveRefresh!: (value: boolean) => void;
    const refresh = new Promise<boolean>((resolve) => {
      resolveRefresh = resolve;
    });
    const handlers = createAppShellSessionEventHandlers({
      uiLocale: 'zh',
      activeIdRef: { current: 'session-1' },
      liveTurnBySessionRef: ref,
      refreshMessages: async () => refresh,
      refreshSessions: async () => [],
      setLiveTurnBySession,
      setInteractionBySession: interactions.set,
      showModelSetupToast: () => {},
      toastApi: { error: () => {} },
    });

    handlers.handleEvent('session-1', {
      type: 'abort', id: 'event-1', turnId: 'turn-1', ts: 1, reason: 'user_stop',
    });

    assert.equal(liveTurns.get()['session-1']?.terminal, true);
    assert.equal(liveTurns.get()['session-1']?.steps[0]?.tools[0]?.status, 'interrupted');

    resolveRefresh(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(liveTurns.get()['session-1']?.terminal, true);
    handlers.reconcilePersistedMessages('session-1', [
      { type: 'tool_call', id: 'tool-1', turnId: 'turn-1', stepId: 'step-1', ts: 2, toolName: 'Bash', args: {} },
    ]);
    assert.equal(liveTurns.get()['session-1'], undefined);
  });

  it('retains errored live evidence when persistence cannot be confirmed', async () => {
    const projection: LiveTurnProjection = {
      turnId: 'turn-1',
      phase: 'streamed',
      steps: [{
        stepId: 'step-1',
        tools: [{
          toolUseId: 'tool-1', toolName: 'Bash', status: 'running', args: {},
          outputChunks: [{
            seq: 0, stream: 'stdout', text: 'partial output', redacted: false, createdAt: 1,
          }],
        }],
      }],
    };
    const liveTurns = createStateSetter<Record<string, LiveTurnProjection>>({ 'session-1': projection });
    const ref = { current: liveTurns.get() };
    const interactions = createStateSetter<InteractionQueues>({});
    let diagnosticDetails: string | undefined;
    let diagnosticTarget:
      | { sessionId: string; turnId: string; eventId: string }
      | undefined;
    const handlers = createAppShellSessionEventHandlers({
      uiLocale: 'zh',
      activeIdRef: { current: 'session-1' },
      liveTurnBySessionRef: ref,
      refreshMessages: async () => false,
      refreshSessions: async () => [],
      setLiveTurnBySession: (updater) => {
        liveTurns.set(updater);
        ref.current = liveTurns.get();
      },
      setInteractionBySession: interactions.set,
      showModelSetupToast: () => {},
      toastApi: {
        error: (_title, _description, details, target) => {
          diagnosticDetails = details;
          diagnosticTarget = target;
        },
      },
    });

    handlers.handleEvent('session-1', {
      type: 'error', id: 'event-1', turnId: 'turn-1', ts: 2,
      code: 'TOOL_FAILED', reason: 'tool_failed', message: 'failed', recoverable: false,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(liveTurns.get()['session-1']?.terminal, true);
    assert.equal(liveTurns.get()['session-1']?.steps[0]?.tools[0]?.status, 'interrupted');
    assert.equal(liveTurns.get()['session-1']?.steps[0]?.tools[0]?.outputChunks?.[0]?.text, 'partial output');
    assert.match(diagnosticDetails ?? '', /Session: session-1/u);
    assert.match(diagnosticDetails ?? '', /Turn: turn-1/u);
    assert.match(diagnosticDetails ?? '', /Reason: tool_failed/u);
    assert.match(diagnosticDetails ?? '', /Code: TOOL_FAILED/u);
    assert.deepEqual(diagnosticTarget, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      eventId: 'event-1',
    });

    handlers.reconcilePersistedMessages('session-1', [
      { type: 'tool_call', id: 'tool-1', turnId: 'turn-1', stepId: 'step-1', ts: 3, toolName: 'Bash', args: {} },
    ]);
    assert.equal(liveTurns.get()['session-1']?.steps[0]?.tools[0]?.outputChunks?.[0]?.text, 'partial output');
    handlers.reconcilePersistedMessages('session-1', [
      { type: 'tool_call', id: 'tool-1', turnId: 'turn-1', stepId: 'step-1', ts: 3, toolName: 'Bash', args: {} },
      { type: 'tool_result', id: 'result-1', turnId: 'turn-1', ts: 4, toolUseId: 'tool-1', isError: true, content: { kind: 'text', text: 'partial output' } },
    ]);
    assert.equal(liveTurns.get()['session-1'], undefined);
  });

  it('reconciles persisted stream evidence while the next tool batch is running', () => {
    const projection: LiveTurnProjection = {
      turnId: 'turn-1',
      phase: 'streamed',
      steps: [
        {
          stepId: 'step-1',
          tools: [{
            toolUseId: 'old-tool', toolName: 'Bash', status: 'completed', args: {},
            outputChunks: [{ seq: 0, stream: 'stdout', text: 'old\n', redacted: false, createdAt: 1 }],
          }],
          contentOrder: ['tools'],
        },
        {
          stepId: 'step-2',
          tools: [{ toolUseId: 'new-tool', toolName: 'Bash', status: 'running', args: {} }],
          contentOrder: ['tools'],
        },
      ],
    };
    const liveTurns = createStateSetter<Record<string, LiveTurnProjection>>({ 'session-1': projection });
    const ref = { current: liveTurns.get() };
    const interactions = createStateSetter<InteractionQueues>({});
    const handlers = createAppShellSessionEventHandlers({
      uiLocale: 'zh',
      activeIdRef: { current: 'session-1' },
      liveTurnBySessionRef: ref,
      refreshMessages: async () => true,
      refreshSessions: async () => [],
      setLiveTurnBySession: (updater) => {
        liveTurns.set(updater);
        ref.current = liveTurns.get();
      },
      setInteractionBySession: interactions.set,
      showModelSetupToast: () => {},
      toastApi: { error: () => {} },
    });

    handlers.reconcilePersistedMessages('session-1', [
      { type: 'tool_call', id: 'old-tool', turnId: 'turn-1', stepId: 'step-1', ts: 1, toolName: 'Bash', args: {} },
      { type: 'tool_result', id: 'old-result', turnId: 'turn-1', ts: 2, toolUseId: 'old-tool', isError: false, content: { kind: 'text', text: 'old\n' } },
    ]);

    assert.deepEqual(liveTurns.get()['session-1']?.steps, [projection.steps[1]]);
  });

  it('settles a tool-only terminal projection after persisted history refreshes', async () => {
    const liveTurns = createStateSetter<Record<string, LiveTurnProjection>>({
      'session-1': {
        turnId: 'turn-1',
        phase: 'streamed',
        steps: [{
          stepId: 'tool:tool-1',
          tools: [{ toolUseId: 'tool-1', toolName: 'Bash', status: 'completed', args: {} }],
        }],
      },
    });
    const ref = { current: liveTurns.get() };
    const interactions = createStateSetter<InteractionQueues>({});
    let resolveRefresh!: (value: boolean) => void;
    const refresh = new Promise<boolean>((resolve) => {
      resolveRefresh = resolve;
    });
    const handlers = createAppShellSessionEventHandlers({
      uiLocale: 'zh',
      activeIdRef: { current: 'session-1' },
      liveTurnBySessionRef: ref,
      refreshMessages: async () => refresh,
      refreshSessions: async () => [],
      setLiveTurnBySession: (updater) => {
        liveTurns.set(updater);
        ref.current = liveTurns.get();
      },
      setInteractionBySession: interactions.set,
      showModelSetupToast: () => {},
      toastApi: { error: () => {} },
    });

    handlers.handleEvent('session-1', {
      type: 'complete', id: 'event-1', turnId: 'turn-1', ts: 2, stopReason: 'end_turn',
    });
    assert.equal(liveTurns.get()['session-1']?.terminal, true);

    resolveRefresh(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    handlers.reconcilePersistedMessages('session-1', [
      { type: 'tool_call', id: 'tool-1', turnId: 'turn-1', stepId: 'tool:tool-1', ts: 2, toolName: 'Bash', args: {} },
      { type: 'tool_result', id: 'result-1', turnId: 'turn-1', ts: 3, toolUseId: 'tool-1', isError: false, content: { kind: 'text', text: 'ok' } },
    ]);
    assert.equal(liveTurns.get()['session-1'], undefined);
  });
});
