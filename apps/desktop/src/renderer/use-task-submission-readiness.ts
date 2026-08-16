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
