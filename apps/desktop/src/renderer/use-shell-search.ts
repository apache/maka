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
