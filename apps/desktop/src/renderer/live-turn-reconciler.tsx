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

import { useEffect } from 'react';
import type { StoredMessage } from '@maka/core/session';
import type { AppShellSessionUiStateController } from './app-shell-session-ui-state';
import { selectLiveTurn } from './use-app-shell-session-ui-reads';
import { useAppShellSessionUiSelector } from './use-app-shell-session-ui-selector';

/**
 * Reconciles the live projection against durable messages, and renders nothing.
 *
 * Tool/thinking evidence may survive its event-triggered refresh, including
 * between steps of one running turn, so this has to run whenever either side
 * changes — old output stays on its original tool instead of joining the next
 * batch, without deleting text that the live renderer still owns.
 *
 * #1985: that means following the projection per delta. Keeping it in AppShell
 * forced the whole shell to subscribe at token rate; as a childless component
 * it can follow every delta while owning no subtree to rebuild.
 */
export function LiveTurnReconciler(props: {
  controller: AppShellSessionUiStateController;
  activeId: string | undefined;
  messages: readonly StoredMessage[];
  reconcile: (sessionId: string, messages: readonly StoredMessage[]) => void;
}): null {
  const { controller, activeId, messages, reconcile } = props;
  const liveTurn = useAppShellSessionUiSelector(controller, selectLiveTurn, activeId);

  useEffect(() => {
    if (!activeId) return;
    reconcile(activeId, messages);
    // `liveTurn` is a trigger, not a read. `reconcile` must come from
    // `useStableActions` — its identity is fixed for the component's lifetime,
    // so it belongs in the deps honestly rather than being hidden behind a
    // wrapper whose identity changes every render.
  }, [activeId, liveTurn, messages, reconcile]);

  return null;
}
