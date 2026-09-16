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

import { useEffect, useMemo, useState } from 'react';
import type { ChatModelChoice } from '@maka/core/chat-model-choice';
import type { SessionSummary } from '@maka/core/session';
import { useWorkHubServices } from '../services.js';
import { startWorkHubCoordinationLifecycle } from './coordination-lifecycle.js';

/** Main owns the panels; the persistent WorkHub renderer owns the conversation. */
export function useWorkHubWorkspace(enabled: boolean, sessionIds: ReadonlySet<string> | undefined) {
  const services = useWorkHubServices();
  const [snapshot, setSnapshot] = useState<{ session: SessionSummary; choices: ChatModelChoice[] }>();
  const session = snapshot?.session;
  useEffect(() => {
    if (!enabled) { setSnapshot(undefined); return; }
    let active = true;
    let currentId: string | undefined;
    let revision = 0;
    const refresh = () => {
      if (!currentId) return;
      const read = ++revision;
      void Promise.all([services.getSession(currentId), services.modelChoices(currentId)]).then(([session, choices]) => {
        if (active && read === revision) setSnapshot({ session, choices });
      }).catch(() => {
        // A metadata read failure must not retire this Session's panel resources.
        // Only the Host lifecycle below invalidates the bound identity.
      });
    };
    const unsubscribe = services.subscribeSessions(refresh);
    const unsubscribeAvailability = services.subscribeAvailability(refresh);
    const stop = startWorkHubCoordinationLifecycle({
      resolve: services.resolve,
      subscribeHostChanges: services.subscribeHosts,
      subscribeAvailabilityChanges: services.subscribeAvailability,
      onResolving: () => { ++revision; currentId = undefined; setSnapshot(undefined); },
      onResolved: (id) => { currentId = id; refresh(); },
      // The conversation owns resolution errors and its retry affordance.
      reportFailure: () => {},
    });
    return () => { active = false; ++revision; unsubscribe(); unsubscribeAvailability(); stop(); };
  }, [enabled, services]);
  const authoritativeSessionIds = useMemo(() => sessionIds && new Set([
    ...sessionIds, ...(session ? [session.id] : []),
  ]), [session, sessionIds]);
  return { session, modelChoices: snapshot?.choices ?? [], authoritativeSessionIds };
}
