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

import type { ComponentType, ReactNode, RefObject } from 'react';
import type { SessionSummary } from '@maka/core/session';
import type { ChatModelChoice, ComposerHandle } from '@maka/ui';

/** Composition supplies the same session workspace used by ordinary conversations. */
export interface SessionWorkspaceProps {
  className?: string;
  layoutScope?: string;
  session?: SessionSummary;
  sessionIds: ReadonlySet<string> | undefined;
  modelChoices: readonly ChatModelChoice[];
  visible: boolean;
  composerRef: RefObject<ComposerHandle | null>;
  onShowConversation(): void;
  onOpenSession(sessionId: string): void;
  children(workbar: { openUsage(): void; toggle: ReactNode }): ReactNode;
}

export type SessionWorkspaceComponent = ComponentType<SessionWorkspaceProps>;
