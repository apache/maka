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
import type { MakaBridge } from '../../../preload/bridge-contract.js';
import type { OnboardingSource } from '../../application/contracts/onboarding/onboarding-authority.js';
import { runOnDefaultRuntimeHost } from './default-runtime-host-operation.js';

/**
 * Named Session events use targeted reads; connection and Owner profile
 * changes request complete snapshots. Settings changes are NOT subscribed:
 * there is no settings-wide event channel, so callers that need a re-pull
 * after a settings-only write (closing Settings) refresh the authority.
 */
export function createDesktopOnboardingSource(
  bridge: Pick<MakaBridge, 'onboarding' | 'sessions' | 'connections' | 'runtimeHostProfiles'> = window.maka,
): OnboardingSource {
  return {
    getSnapshot: () => bridge.onboarding.getSnapshot(),
    getSessionUpdate: (sessionId) => bridge.onboarding.getSessionUpdate(sessionId),
    subscribeInvalidations(onInvalidate) {
      const unsubscribeSessions = bridge.sessions.subscribeChanges((event) =>
        onInvalidate(event.sessionId));
      const unsubscribeConnections = bridge.connections.subscribeEvents(() => onInvalidate());
      const unsubscribeProfiles = bridge.runtimeHostProfiles.subscribeChanges((event) => {
        if (event.profileAccess === 'owner' || event.isDefault) onInvalidate();
      });
      return () => {
        unsubscribeSessions();
        unsubscribeConnections();
        unsubscribeProfiles();
      };
    },
    skipInitialOnboarding: async () => {
      await runOnDefaultRuntimeHost((host) =>
        bridge.onboarding.setMilestone('initial_onboarding', 'skipped', host));
    },
  };
}
