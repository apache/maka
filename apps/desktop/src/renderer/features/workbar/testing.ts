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

import type { WorkbarServices } from './ports.js';

export { WorkbarServicesProvider } from './services-context.js';
export type {
  WorkbarServices,
  WorkbarSessionTracePage,
  WorkbarSessionUsageSummary,
} from './ports.js';

export * from './model/workbar-tabs.js';
export * from './model/workbar-layout.js';
export * from './model/workbar-tool-definitions.js';
export * from './tools/artifacts/artifact-list-keyboard.js';
export * from './tools/artifacts/artifact-visibility.js';
export * from './tools/inspector/session-inspector-panel-model.js';
export { compactNumberFormatter, InspectorCompositionSection } from './tools/inspector/session-inspector-panel.js';
export * from './tools/inspector/session-inspector-overview-model.js';
export * from './tools/side-chat/quote-companion-panel-state.js';
export * from './tools/side-chat/quote-companion-core.js';
export * from './tools/side-chat/quote-companion-visibility.js';
export { useQuoteCompanion } from './tools/side-chat/use-quote-companion.js';
export * from './tools/terminal/session-terminal-hydration.js';
export * from './tools/terminal/session-terminal-query.js';
export * from './tools/terminal/session-terminal-frame.js';
export * from './tools/inspector/use-session-trace.js';
export * from './controller/use-workbar-controller.js';
export { SideChatCloseConfirmation } from './ui/side-chat-close-confirmation.js';

const noopSubscription = (): (() => void) => () => undefined;

/**
 * Environment-free Workbar service defaults for unit tests and Storybook.
 * Tests override complete capability groups so adding a method cannot silently
 * fall through to the Desktop bridge.
 */
export function createFakeWorkbarServices(
  overrides: Partial<WorkbarServices> = {},
): WorkbarServices {
  return {
    review: {
      read: async () => {
        throw new Error('Fake review.read is not configured');
      },
      subscribeSessionEvents: noopSubscription,
    },
    terminal: {
      start: async () => {
        throw new Error('Fake terminal.start is not configured');
      },
      stop: async () => null,
      attach: async () => null,
      detach: async () => undefined,
      write: async () => null,
      subscribePtyData: noopSubscription,
      subscribeResync: noopSubscription,
    },
    todo: {
      read: async () => [],
      subscribeChanges: noopSubscription,
    },
    browser: {
      setActiveSession: () => undefined,
      setViewport: () => undefined,
      navigate: async () => undefined,
      back: async () => undefined,
      forward: async () => undefined,
      reload: async () => undefined,
      stop: async () => undefined,
      close: async () => undefined,
      getState: async () => null,
      subscribeState: noopSubscription,
      subscribeLive: noopSubscription,
    },
    artifacts: {
      list: async () => [],
      readText: async () => ({ ok: false, reason: 'not_found' }),
      readBinary: async () => ({ ok: false, reason: 'not_found' }),
      delete: async () => undefined,
      subscribeChanges: noopSubscription,
      openPath: async () => ({ ok: false, reason: 'missing' }),
      saveAs: async () => ({ ok: false, reason: 'canceled' }),
    },
    inspector: {
      trace: async () => {
        throw new Error('Fake inspector.trace is not configured');
      },
      summary: async () => {
        throw new Error('Fake inspector.summary is not configured');
      },
      context: async () => {
        throw new Error('Fake inspector.context is not configured');
      },
      subscribeSessionEvents: noopSubscription,
      subscribeUsageChanges: noopSubscription,
    },
    attachments: {
      readBytes: async () => ({ ok: false, reason: 'not_found' }),
      pickFiles: async () => ({ ok: false, reason: 'cancelled' }),
      previewApproval: async () => ({ ok: false, reason: 'not configured' }),
    },
    sideChat: {
      listSessions: async () => [],
      listTurns: async () => [],
      readSettledMessages: async () => ({ messages: [], settled: true }),
      branchFromTurn: async () => {
        throw new Error('Fake sideChat.branchFromTurn is not configured');
      },
      cleanupSessionCopy: async () => undefined,
      abandonSessionCopy: async () => undefined,
      send: async () => ({ ok: false, reason: 'not configured' }),
      stop: async () => undefined,
      steer: async () => {
        throw new Error('Fake sideChat.steer is not configured');
      },
      setPermissionMode: async () => {
        throw new Error('Fake sideChat.setPermissionMode is not configured');
      },
      regenerateTurn: async () => undefined,
      respondToSandboxBoundary: async () => undefined,
      respondToClientCapability: async () => undefined,
      respondToUserQuestion: async () => undefined,
      subscribeEvents: (_sessionId, _handler, onSeeded) => {
        onSeeded?.();
        return noopSubscription();
      },
      subscribeSessionChanges: noopSubscription,
    },
    ...overrides,
  };
}
