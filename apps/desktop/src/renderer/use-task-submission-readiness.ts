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
import type {
  DesktopNewTaskTarget,
  DesktopTaskSubmissionReadinessRequest,
} from '../preload/bridge-contract.js';

export function useTaskSubmissionReadiness(
  request: DesktopTaskSubmissionReadinessRequest,
  refreshKey: unknown,
  sessionId?: string,
  newTaskTarget?: DesktopNewTaskTarget,
) {
  const [snapshot, setSnapshot] = useState<TaskSubmissionReadinessSnapshot>();
  const [revision, setRevision] = useState(0);
  const requestSequence = useRef(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  const checkNow = useCallback(async () => {
    const sequence = ++requestSequence.current;
    try {
      const next = sessionId
        ? await window.maka.taskReadiness.getSnapshot(request, sessionId)
        : newTaskTarget
          ? await window.maka.newTasks.getReadiness(newTaskTarget, request)
          : undefined;
      if (requestSequence.current === sequence) setSnapshot(next);
      return next;
    } catch {
      if (requestSequence.current === sequence) setSnapshot(undefined);
      return undefined;
    }
  }, [
    request.connectionSlug,
    request.model,
    request.cwd,
    sessionId,
    newTaskTarget?.profileId,
    newTaskTarget?.hostId,
    newTaskTarget?.projectId,
  ]);

  useEffect(() => {
    requestSequence.current += 1;
    setSnapshot(undefined);
    void checkNow();
  }, [checkNow, refreshKey, revision]);

  return { snapshot, refresh, checkNow };
}
