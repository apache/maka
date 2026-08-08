import { useCallback, useEffect, useState } from 'react';
import type { TaskSubmissionReadinessSnapshot } from '@maka/core';
import type { DesktopTaskSubmissionReadinessRequest } from '../preload/bridge-contract.js';

export function useTaskSubmissionReadiness(
  request: DesktopTaskSubmissionReadinessRequest,
  refreshKey: unknown,
) {
  const [snapshot, setSnapshot] = useState<TaskSubmissionReadinessSnapshot>();
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let current = true;
    setSnapshot(undefined);
    void window.maka.taskReadiness
      .getSnapshot(request)
      .then((next) => {
        if (current) setSnapshot(next);
      })
      .catch(() => {
        if (current) setSnapshot(undefined);
      });
    return () => {
      current = false;
    };
  }, [request.connectionSlug, request.model, request.cwd, refreshKey, revision]);

  return { snapshot, refresh };
}
