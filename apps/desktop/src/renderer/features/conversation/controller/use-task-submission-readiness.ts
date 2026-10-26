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

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskSubmissionReadinessSnapshot } from '@maka/core/task-submission-readiness';
import type { ConversationNewTaskTarget } from '../ports.js';
import type { TaskReadinessRequest, TaskReadinessServices } from '../readiness-services.js';

/**
 * Called only by `TaskReadinessProvider`. Request changes clear the previous
 * snapshot; refreshes retain confirmed workspace blockers until a new answer.
 * Only the latest read publishes, including after cleanup and focus events.
 */
export function useTaskSubmissionReadiness(
  services: TaskReadinessServices,
  request: TaskReadinessRequest,
  refreshKey: unknown,
  sessionId?: string,
  newTaskTarget?: ConversationNewTaskTarget,
) {
  const [snapshot, setSnapshot] = useState<TaskSubmissionReadinessSnapshot>();
  const requestSequence = useRef(0);

  const checkNow = useCallback(async () => {
    const sequence = ++requestSequence.current;
    try {
      const next = sessionId
        ? await services.readSession(sessionId, request)
        : newTaskTarget
          ? await services.readNewTask(newTaskTarget, request)
          : undefined;
      if (requestSequence.current === sequence) setSnapshot(next);
    } catch {
      if (requestSequence.current === sequence) setSnapshot(retainWorkspaceBlocker);
    }
  }, [
    services,
    request.connectionSlug,
    request.model,
    request.cwd,
    request.workspaceFixed,
    sessionId,
    newTaskTarget?.profileId,
    newTaskTarget?.hostId,
    newTaskTarget?.projectId,
  ]);

  useEffect(() => {
    requestSequence.current += 1;
    setSnapshot(undefined);
    void checkNow();
    return () => { requestSequence.current += 1; };
  }, [checkNow, refreshKey]);

  // Keep the last confirmed blocker while refreshing the same target. A
  // cleanup event or return from an external deletion must recheck readiness.
  const refresh = useCallback(() => {
    setSnapshot(retainWorkspaceBlocker);
    void checkNow();
  }, [checkNow]);
  useEffect(() => services.subscribeChanges(refresh), [services, refresh]);
  useEffect(() => {
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);

  return { snapshot, refresh };
}

function retainWorkspaceBlocker(snapshot: TaskSubmissionReadinessSnapshot | undefined) {
  return snapshot?.blockers.some(
    (blocker) => blocker.id === 'workspace' && blocker.state !== 'unknown',
  ) ? snapshot : undefined;
}
