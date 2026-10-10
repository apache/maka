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
import type { ContextCompactResult } from '@maka/runtime-host/protocol';
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
  'listMessages' | 'cancelMessage' | 'reconcileMessage' | 'subscribeChanges'
> {
  readonly observation: import('./transcript-ports.js').ConversationObservationServices;
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
    promoteQueueEntry(sessionId: string, entryId: string): Promise<void>;
    retractQueueEntry(sessionId: string, entryId: string): Promise<void>;
    updateQueueEntry?(sessionId: string, entryId: string, expectedQueueRevision: number, text: string): Promise<void>;
    reorderQueueEntries(
      sessionId: string,
      entryIds: readonly string[],
      expectedQueueRevision: number,
    ): Promise<void>;
    compact(sessionId: string): Promise<ContextCompactResult>;
    /** Sampled prompt-rail landmarks, or where the one Turn `turnId` sits. */
    listTurnLandmarks(
      sessionId: string,
      turnId: string | null,
    ): Promise<{ readonly landmarks: readonly import('./controller/transcript-reading-position-controller.js').TranscriptTurnLandmark[] }>;
  };
  readonly runtimeHosts: {
    subscribeChanges(handler: (event: ConversationHostChange) => void): () => void;
  };
  /**
   * Safe-boundary resume (#1223, #5903): the read-only plan preview behind the
   * composer's Resume offer, the admission behind every resume click, and the
   * catalog changes that move the answer.
   */
  readonly resume: {
    queryPlan(sessionId: string): Promise<import('@maka/runtime-host/protocol').TurnResumePlan>;
    start(sessionId: string): Promise<
      | { readonly disposition: 'started'; readonly runId: string; readonly turnId: string }
      | { readonly disposition: 'park'; readonly rejectionReasons: readonly string[]; readonly diagnostics: readonly unknown[] }
    >;
    subscribeChanges(handler: (event: import('@maka/core/session').SessionChangedEvent) => void): () => void;
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
    getExecutors?(target: ConversationNewTaskTarget, cwd: string, refresh?: boolean): Promise<readonly import('@maka/core/executor-catalog').ExecutorCatalogEntry[]>;
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
