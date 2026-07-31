import { useCallback, useMemo, useState } from 'react';

type OpenSessionInChat = (sessionId: string, turnId?: string) => void;

/**
 * Owns the search-modal slice (issue #1043): the open flag, the scroll-target
 * anchor handed to ChatView, the close handler (restores focus to the sidebar
 * trigger), and the stable search-thread dep + navigate callback.
 *
 * `openSessionInChatRef` is AppShell's stable ref so the navigate callback
 * stays memoized across renders while always calling the latest opener.
 */
export function useShellSearch({ openSessionInChatRef }: { openSessionInChatRef: { current: OpenSessionInChat } }) {
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [searchScrollTarget, setSearchScrollTarget] = useState<{
    sessionId: string;
    turnId: string;
    nonce: number;
  } | null>(null);

  function closeSearchModal(options?: { restoreFocus?: boolean }) {
    setSearchModalOpen(false);
    if (options?.restoreFocus === false) return;
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLButtonElement>('[data-maka-search-trigger="true"]')
        ?.focus({ preventScroll: true });
    });
  }

  const searchModalDeps = useMemo(
    () => ({ searchThread: (request: Parameters<typeof window.maka.search.thread>[0]) => window.maka.search.thread(request) }),
    [],
  );

  const searchModalOnNavigate = useCallback((sessionId: string, turnId?: string) => {
    openSessionInChatRef.current(sessionId, turnId);
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
