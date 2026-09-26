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

import type { ExecutionBoundaryReadModel } from '@maka/core/sandbox-boundary';
import type { SessionSnapshot } from '@maka/core/session-reference';
import type { ChatDefaultPermissionMode } from '@maka/core/settings';
import type { InvocableSkillEntry } from '@maka/runtime/skill-invocation';
import type { DesktopSessionSummary } from '../../../shared/desktop-session-projection.js';
import type { DesktopSessionLocalBridge } from '../../../shared/session-local-contract.js';

export type ConversationSession = Pick<
  DesktopSessionSummary,
  | 'id'
  | 'name'
  | 'status'
  | 'lastMessageAt'
  | 'lastMessagePreview'
  | 'isArchived'
  | 'runtimeHostId'
  | 'shared'
>;

export interface ConversationHostChange {
  readonly hostId?: string;
  readonly readiness: 'connecting' | 'ready' | 'reconnecting' | 'unavailable';
}

export interface ConversationNewTaskTarget {
  readonly profileId: string;
  readonly hostId: string;
  readonly projectId: string | null;
}

export type ConversationFileSearchResult =
  | { readonly ok: true; readonly files: Array<{ readonly relativePath: string }> }
  | { readonly ok: false; readonly reason: 'no_project' | 'search_failed' };

export interface ConversationServices extends Pick<
  DesktopSessionLocalBridge,
  'listMessages' | 'readFailedMessage' | 'cancelMessage' | 'reconcileMessage' | 'subscribeChanges'
> {
  readonly promptSuggestions?: {
    generate(sessionId: string): Promise<string | undefined>;
    readEnabled(): boolean;
    subscribeEnabled?(handler: () => void): () => void;
    writeEnabled(enabled: boolean): void;
  };
  readonly sessions: {
    getExecutorState?(sessionId: string): Promise<readonly import('@maka/core/executor-catalog').ExecutorCatalogEntry[]>;
    setExecutorModelConfiguration?(sessionId: string, config: import('@maka/core/executor-catalog').ExecutorConfiguration): Promise<import('../../../shared/desktop-session-projection.js').DesktopSessionUpdateResult<DesktopSessionSummary>>;
    readSnapshot(sessionId: string, options?: { readonly maxChars?: number }): Promise<SessionSnapshot>;
    readExecutionBoundary(sessionId: string): Promise<ExecutionBoundaryReadModel>;
  };
  readonly runtimeHosts: {
    subscribeChanges(handler: (event: ConversationHostChange) => void): () => void;
  };
  readonly skills: {
    listInvocable(sessionId?: string): Promise<InvocableSkillEntry[]>;
  };
  readonly workspace: {
    searchFiles(
      query: string,
      options?: { readonly sessionId?: string; readonly limit?: number },
    ): Promise<ConversationFileSearchResult>;
  };
  readonly newTasks: {
    getExecutors?(target: ConversationNewTaskTarget, cwd: string): Promise<readonly import('@maka/core/executor-catalog').ExecutorCatalogEntry[]>;
    subscribeChanges(handler: () => void): () => void;
    listInvocableSkills(
      target: ConversationNewTaskTarget,
      context?: {
        readonly llmConnectionSlug?: string;
        readonly model?: string;
        readonly collaborationMode?: 'agent' | 'plan';
        readonly permissionMode?: ChatDefaultPermissionMode;
      },
    ): Promise<InvocableSkillEntry[]>;
    searchFiles(
      target: ConversationNewTaskTarget,
      query: string,
      options?: { readonly limit?: number },
    ): Promise<ConversationFileSearchResult>;
  };
  readonly mcp: {
    subscribeChanges(handler: () => void): () => void;
  };
}
