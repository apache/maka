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
import { generalizedErrorMessage, generalizedErrorMessageChinese } from '@maka/core/redaction';
import { type Task } from '@maka/core/task-ledger';
import { useUiLocale } from '@maka/ui';
import { getShellRemainingCopy } from './locales/shell-remaining-copy.js';

interface SessionTaskSnapshot {
  sessionId?: string;
  tasks: Task[];
  loading: boolean;
  error?: string;
}

const EMPTY_SNAPSHOT: SessionTaskSnapshot = {
  tasks: [],
  loading: false,
};

export function useSessionTasks(sessionId: string | undefined): SessionTaskSnapshot & { retry: () => void } {
  const locale = useUiLocale();
  const copy = getShellRemainingCopy(locale).tasks;
  const revisionRef = useRef(0);
  const [snapshot, setSnapshot] = useState<SessionTaskSnapshot>(EMPTY_SNAPSHOT);

  const load = useCallback((targetSessionId: string, preserveTasks: boolean) => {
    const revision = ++revisionRef.current;
    setSnapshot((current) => ({
      sessionId: targetSessionId,
      tasks: preserveTasks && current.sessionId === targetSessionId ? current.tasks : [],
      loading: true,
    }));
    void window.maka.tasks.list(targetSessionId).then(
      (tasks) => {
        if (revision !== revisionRef.current) return;
        setSnapshot({ sessionId: targetSessionId, tasks, loading: false });
      },
      (error: unknown) => {
        if (revision !== revisionRef.current) return;
        setSnapshot((current) => ({
          sessionId: targetSessionId,
          tasks: current.sessionId === targetSessionId ? current.tasks : [],
          loading: false,
          error: locale === 'zh'
            ? generalizedErrorMessageChinese(error, copy.loadFailed)
            : generalizedErrorMessage(error, copy.loadFailed),
        }));
      },
    );
  }, [copy.loadFailed, locale]);

  useEffect(() => {
    revisionRef.current += 1;
    if (!sessionId) {
      setSnapshot(EMPTY_SNAPSHOT);
      return;
    }
    const unsubscribe = window.maka.tasks.subscribeChanges((event) => {
      if (event.sessionId === sessionId) load(sessionId, true);
    });
    load(sessionId, false);
    return () => {
      revisionRef.current += 1;
      unsubscribe();
    };
  }, [load, sessionId]);

  const retry = useCallback(() => {
    if (sessionId) load(sessionId, true);
  }, [load, sessionId]);

  if (snapshot.sessionId !== sessionId) {
    return { ...EMPTY_SNAPSHOT, loading: Boolean(sessionId), retry };
  }
  return { ...snapshot, retry };
}
