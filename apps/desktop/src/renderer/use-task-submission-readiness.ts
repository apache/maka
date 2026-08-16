import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskSubmissionReadinessSnapshot } from '@maka/core/task-submission-readiness';
import type { DesktopTaskSubmissionReadinessRequest } from '../preload/bridge-contract.js';

export function useTaskSubmissionReadiness(
  request: DesktopTaskSubmissionReadinessRequest,
  refreshKey: unknown,
  sessionId?: string,
) {
  const [snapshot, setSnapshot] = useState<TaskSubmissionReadinessSnapshot>();
  const [revision, setRevision] = useState(0);
  const requestSequence = useRef(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  const checkNow = useCallback(async () => {
    const sequence = ++requestSequence.current;
    try {
      const next = await window.maka.taskReadiness.getSnapshot(request, sessionId);
      if (requestSequence.current === sequence) setSnapshot(next);
      return next;
    } catch {
      if (requestSequence.current === sequence) setSnapshot(undefined);
      return undefined;
    }
  }, [request.connectionSlug, request.model, request.cwd, sessionId]);

  useEffect(() => {
    requestSequence.current += 1;
    setSnapshot(undefined);
    void checkNow();
  }, [checkNow, refreshKey, revision]);

  return { snapshot, refresh, checkNow };
}
