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
import { generalizedErrorMessageForLocale } from '@maka/core/redaction';
import type { SessionTodoItem } from '@maka/core/session-todo';
import type { UiLocale } from '@maka/ui';
import { useWorkbarServices } from '../../services-context.js';

interface SessionTodoView {
  sessionId?: string;
  items: SessionTodoItem[];
  loading: boolean;
  error?: string;
}

const EMPTY: SessionTodoView = { items: [], loading: false };

export function useSessionTodo(
  sessionId: string | undefined,
  copy: { locale: UiLocale; loadFailed: string },
): SessionTodoView & { retry: () => void } {
  const { todo } = useWorkbarServices();
  const generation = useRef(0);
  const [snapshot, setSnapshot] = useState<SessionTodoView>(EMPTY);

  const load = useCallback((targetSessionId: string, preserve: boolean) => {
    const requestGeneration = ++generation.current;
    setSnapshot((current) => ({
      sessionId: targetSessionId,
      items: preserve && current.sessionId === targetSessionId ? current.items : [],
      loading: true,
    }));
    void todo.read(targetSessionId).then(
      (items) => {
        if (requestGeneration !== generation.current) return;
        setSnapshot({ sessionId: targetSessionId, items, loading: false });
      },
      (error: unknown) => {
        if (requestGeneration !== generation.current) return;
        setSnapshot((current) => ({
          sessionId: targetSessionId,
          items: current.sessionId === targetSessionId ? current.items : [],
          loading: false,
          error: generalizedErrorMessageForLocale(error, copy.loadFailed, copy.locale),
        }));
      },
    );
  }, [copy.loadFailed, copy.locale, todo]);

  useEffect(() => {
    generation.current += 1;
    if (!sessionId) {
      setSnapshot(EMPTY);
      return;
    }
    const unsubscribe = todo.subscribeChanges((event) => {
      if (event.sessionId === sessionId) load(sessionId, true);
    });
    load(sessionId, false);
    return () => {
      generation.current += 1;
      unsubscribe();
    };
  }, [load, sessionId, todo]);

  const retry = useCallback(() => {
    if (sessionId) load(sessionId, true);
  }, [load, sessionId]);

  if (snapshot.sessionId !== sessionId) return { ...EMPTY, loading: Boolean(sessionId), retry };
  return { ...snapshot, retry };
}
