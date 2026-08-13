import { useEffect, useState } from 'react';
import type { DeepResearchClientProgress } from '@maka/core/deep-research-run';

export function useDeepResearchRun(
  sessionId: string | undefined,
  enabled: boolean,
): DeepResearchClientProgress | undefined {
  const [run, setRun] = useState<DeepResearchClientProgress>();

  useEffect(() => {
    let active = true;
    let request = 0;
    if (!sessionId || !enabled) {
      setRun(undefined);
      return () => {
        active = false;
      };
    }

    const refresh = async () => {
      const currentRequest = ++request;
      const next = await window.maka.deepResearch.get(sessionId);
      if (active && currentRequest === request) setRun(next);
    };
    void refresh().catch(() => {
      if (active) setRun(undefined);
    });
    const unsubscribe = window.maka.deepResearch.subscribeChanges((event) => {
      if (event.sessionId === sessionId) {
        void refresh().catch(() => undefined);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [enabled, sessionId]);

  return enabled && run?.sessionId === sessionId ? run : undefined;
}
