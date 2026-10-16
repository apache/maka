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

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { startWorkHubCoordinationLifecycle, type WorkHubCoordinationHostChange } from './coordination-lifecycle.js';

/** Canonical identity needed by Main's panels, independently of the conversation renderer. */
export interface WorkHubWorkspaceServices {
  resolve(): Promise<string>;
  subscribeHosts(handler: (event: WorkHubCoordinationHostChange) => void): () => void;
  subscribeAvailability(handler: () => void): () => void;
}

const ServicesContext = createContext<WorkHubWorkspaceServices | null>(null);
export const WorkHubWorkspaceServicesProvider = ServicesContext.Provider;

/** Main owns the panels; the persistent WorkHub renderer owns the conversation. */
export function useWorkHubWorkspace(enabled: boolean, sessionIds: ReadonlySet<string> | undefined) {
  const services = useContext(ServicesContext);
  const [sessionId, setSessionId] = useState<string>();
  useEffect(() => {
    if (!enabled) { setSessionId(undefined); return; }
    if (!services) throw new Error('WorkHub workspace services are required when enabled');
    return startWorkHubCoordinationLifecycle({
      resolve: services.resolve,
      subscribeHostChanges: services.subscribeHosts,
      subscribeAvailabilityChanges: services.subscribeAvailability,
      onResolving: () => setSessionId(undefined),
      onResolved: setSessionId,
      // The conversation owns resolution errors and its retry affordance.
      reportFailure: () => {},
    });
  }, [enabled, services]);
  const authoritativeSessionIds = useMemo(() => sessionIds && new Set([
    ...sessionIds, ...(sessionId ? [sessionId] : []),
  ]), [sessionId, sessionIds]);
  return { sessionId, authoritativeSessionIds };
}
