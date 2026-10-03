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

import { createElement, type ReactNode } from 'react';
import {
  ComposerSubmissionProvider,
  ComposerSubmissionServicesProvider,
  createComposerStagingCommands,
  createComposerSubmissionCommands,
  type ComposerSubmissionServices,
} from '../../renderer/features/conversation/index.js';

type ProviderProps = Parameters<typeof ComposerSubmissionProvider<{ sessionId: string | undefined }>>[0];

const unexpected = (name: string) => async (): Promise<never> => {
  throw new Error(`${name} is not stubbed`);
};

/** Host operations a suite has not stubbed fail loudly instead of resolving. */
export function stubSubmissionServices(overrides: Partial<ComposerSubmissionServices> = {}): ComposerSubmissionServices {
  return {
    submitMessage: unexpected('submitMessage'),
    createNewTask: unexpected('createNewTask'),
    removeUnsentSession: unexpected('removeUnsentSession'),
    reviseBeforeTurn: unexpected('reviseBeforeTurn'),
    abandonSessionCopy: unexpected('abandonSessionCopy'),
    stop: unexpected('stop'),
    branchFromTurn: unexpected('branchFromTurn'),
    respondToSandboxBoundary: unexpected('respondToSandboxBoundary'),
    respondToUserQuestion: unexpected('respondToUserQuestion'),
    ...overrides,
  };
}

/** A shell whose navigation and other-feature commands are inert unless a suite overrides them. */
export function stubSubmissionShell(
  overrides: Partial<ProviderProps['shell']> = {},
): ProviderProps['shell'] {
  return {
    captureOwner: () => ({ sessionId: undefined }),
    isOwnerActive: () => true,
    isNewChatOwnerActive: () => true,
    activateFirstSendSession: async () => {},
    openSession: () => {},
    retireSession: () => {},
    refreshSessions: async () => [],
    reloadExecutionBoundary: () => {},
    respondToUserForm: async () => {},
    showModelSetupToast: () => {},
    bindNewTaskSessionResolver: () => () => {},
    openSideChat: () => {},
    turnActions: { addKey: () => true, clearKey: () => {}, keyOf: (...parts) => parts.join(':') },
    orchestrationMode: () => 'default',
    setOrchestrationModeActive: async () => true,
    ...overrides,
  };
}

export function stubNewTaskSubmission(
  overrides: Partial<ProviderProps['newTask']> = {},
): ProviderProps['newTask'] {
  return {
    target: { profileId: 'local', hostId: 'host-local', projectId: null },
    model: null,
    thinkingLevel: null,
    permissionChoice: undefined,
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    clearPermissionChoice: () => {},
    ...overrides,
  };
}

/** Mounts the Composer submission owner the way AppShell does, over inert ports. */
export function withComposerSubmission(children: ReactNode, options: {
  services?: ComposerSubmissionServices;
  props?: Partial<ProviderProps>;
} = {}) {
  return createElement(ComposerSubmissionServicesProvider, {
    services: options.services ?? stubSubmissionServices(),
    children: createElement(ComposerSubmissionProvider<{ sessionId: string | undefined }>, {
      commands: createComposerSubmissionCommands(),
      staging: createComposerStagingCommands(),
      shell: stubSubmissionShell(),
      newTask: stubNewTaskSubmission(),
      sharedSessionActive: false,
      ...options.props,
      children,
    }),
  });
}
