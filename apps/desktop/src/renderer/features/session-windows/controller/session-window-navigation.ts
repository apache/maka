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

import type { SessionSummary } from '@maka/core/session';
import { collapseSessionRevisions } from '@maka/core/session-revisions';
import { hasNewTaskReloadIntent } from '../../../application/contracts/new-task-reload-intent.js';
import type { SessionWindowContext, SessionWindowNavigation } from '../ports.js';

/** Known local membership preserves synchronous selection and history behavior. */
export function createSessionWindowNavigator(deps: {
  owns(sessionId: string): boolean;
  route(navigation: SessionWindowNavigation): void;
  blocked(): boolean;
}) {
  return (navigation: SessionWindowNavigation, activate: () => void): boolean => {
    if (deps.blocked()) return false;
    if (!deps.owns(navigation.sessionId)) { deps.route(navigation); return false; }
    activate();
    return true;
  };
}

/** Startup may resume history only while the user still owns the initial empty selection. */
export async function bootstrapSessionWindow(input: {
  kind: SessionWindowContext['kind'] | undefined;
  refresh(): Promise<SessionSummary[]>;
  revision(): number;
  open(id: string): void;
}): Promise<void> {
  const explicitNewTask = hasNewTaskReloadIntent();
  const initialRevision = input.revision();
  const sessions = await input.refresh();
  if (input.kind !== 'main' || explicitNewTask || hasNewTaskReloadIntent() ||
    initialRevision !== 0 || input.revision() !== initialRevision) return;
  const candidate = collapseSessionRevisions(sessions).find((session) => !session.isArchived);
  if (candidate?.lastMessageAt) input.open(candidate.id);
}
