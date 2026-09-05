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

import type { SessionSnapshot } from '@maka/core/session-reference';
import type { SessionChangedEvent, SessionSummary } from '@maka/core/session';
import type { ChatDefaultPermissionMode } from '@maka/core/settings';
import type { InvocableSkillEntry } from '@maka/runtime/skill-invocation';

export interface ConversationSession extends SessionSummary {
  readonly runtimeHostId: string;
  readonly shared?: true;
}

export interface ConversationTaskTarget {
  readonly profileId: string;
  readonly hostId: string;
  readonly projectId: string | null;
}

export interface ConversationServices {
  readonly sessions: {
    list(): Promise<readonly ConversationSession[]>;
    subscribeChanges(handler: (event: SessionChangedEvent) => void): () => void;
    readSnapshot(sessionId: string): Promise<SessionSnapshot>;
  };
  readonly skills: {
    listInvocable(
      sessionId?: string,
      context?: {
        llmConnectionSlug?: string;
        model?: string;
        collaborationMode?: 'agent' | 'plan';
        permissionMode?: ChatDefaultPermissionMode;
      },
    ): Promise<readonly InvocableSkillEntry[]>;
  };
  readonly workspace: {
    searchFiles(
      query: string,
      options?: { sessionId?: string },
    ): Promise<
      | { ok: true; files: Array<{ relativePath: string }> }
      | { ok: false; reason: 'no_project' | 'search_failed' }
    >;
  };
  readonly newTasks: {
    subscribeChanges(handler: () => void): () => void;
    listInvocableSkills(
      target: ConversationTaskTarget,
      context?: {
        llmConnectionSlug?: string;
        model?: string;
        collaborationMode?: 'agent' | 'plan';
        permissionMode?: ChatDefaultPermissionMode;
      },
    ): Promise<readonly InvocableSkillEntry[]>;
    searchFiles(
      target: ConversationTaskTarget,
      query: string,
    ): Promise<
      | { ok: true; files: Array<{ relativePath: string }> }
      | { ok: false; reason: 'no_project' | 'search_failed' }
    >;
  };
  readonly mcp: {
    subscribeChanges(handler: () => void): () => void;
  };
}
