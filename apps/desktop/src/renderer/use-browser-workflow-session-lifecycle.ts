import { useCallback, useEffect, useRef } from 'react';

export function useBrowserWorkflowSessionLifecycle(sessionId: string): (ownerSessionId: string) => boolean {
  const sessionIdRef = useRef(sessionId);
  const lifecycleRef = useRef(0);
  const mountedRef = useRef(true);
  sessionIdRef.current = sessionId;

  useEffect(() => {
    const lifecycle = ++lifecycleRef.current;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const releasedSessionId = sessionIdRef.current;
      queueMicrotask(() => {
        if (lifecycleRef.current !== lifecycle) return;
        window.maka.browser.workflows.releaseSession(releasedSessionId);
      });
    };
  }, []);

  return useCallback(
    (ownerSessionId: string) => mountedRef.current && sessionIdRef.current === ownerSessionId,
    [],
  );
}
