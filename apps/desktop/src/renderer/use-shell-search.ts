import { useCallback, useMemo, useState } from 'react';

type OpenSessionInChat = (sessionId: string, turnId?: string, sequence?: number) => void;

/**
 * Owns the search-modal slice (issue #1043): the open flag, the scroll-target
 * anchor handed to ChatView, the close handler, and the stable search-thread
 * dep + navigate callback. Astryx restores the opener for ordinary closes.
 *
 * `openSessionInChatRef` is AppShell's stable ref so the navigate callback
 * stays memoized across renders while always calling the latest opener.
 */
export function useShellSearch({ openSessionInChatRef }: { openSessionInChatRef: { current: OpenSessionInChat } }) {
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [searchScrollTarget, setSearchScrollTarget] = useState<{
    sessionId: string;
    turnId: string;
    sequence?: number;
    nonce: number;
  } | null>(null);

  function closeSearchModal() {
    setSearchModalOpen(false);
  }

  const searchModalDeps = useMemo(
    () => ({ searchThread: (request: Parameters<typeof window.maka.search.thread>[0]) => window.maka.search.thread(request) }),
    [],
  );

  const searchModalOnNavigate = useCallback((sessionId: string, turnId?: string, sequence?: number) => {
    openSessionInChatRef.current(sessionId, turnId, sequence);
  }, [openSessionInChatRef]);

  return {
    searchModalOpen,
    setSearchModalOpen,
    searchScrollTarget,
    setSearchScrollTarget,
    closeSearchModal,
    searchModalDeps,
    searchModalOnNavigate,
  };
}
