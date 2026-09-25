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

import { generalizedErrorMessageForLocale } from '@maka/core/redaction';
import { hasSettledInitialOnboarding } from '@maka/core/onboarding-milestone';
import type { UiLocale } from '@maka/core/ui-locale';
import type { OnboardingSnapshot } from '../../../preload/bridge-contract.js';
import { getOnboardingCopy } from '../../locales/onboarding-copy.js';

export function getOnboardingActivationCandidate(
  snapshot: Pick<OnboardingSnapshot, 'state' | 'milestones'> | null,
  hasWorkspaceHistory: boolean,
): { llmConnectionSlug: string; model: string } | undefined {
  if (
    snapshot?.state.kind !== 'ready_empty' ||
    hasWorkspaceHistory ||
    hasSettledInitialOnboarding(snapshot.milestones)
  ) {
    return undefined;
  }
  return {
    llmConnectionSlug: snapshot.state.connectionSlug,
    model: snapshot.state.model,
  };
}

export function onboardingSnapshotErrorMessage(error: unknown, locale: UiLocale): string {
  const fallback = getOnboardingCopy(locale).snapshotErrorFallback;
  return generalizedErrorMessageForLocale(error, fallback, locale);
}

export const desktopOnboardingSnapshotDeps = {
  getSnapshot: () => window.maka.onboarding.getSnapshot(),
  getSessionUpdate: (sessionId: string) => window.maka.onboarding.getSessionUpdate(sessionId),
  subscribeInvalidations(onInvalidate: (sessionId?: string) => void) {
    const unsubscribeSessions = window.maka.sessions.subscribeChanges((event) =>
      onInvalidate(event.sessionId));
    const unsubscribeConnections = window.maka.connections.subscribeEvents(() => onInvalidate());
    const unsubscribeProfiles = window.maka.runtimeHostProfiles.subscribeChanges((event) => {
      if (event.profileAccess === 'owner' || event.isDefault) onInvalidate();
    });
    return () => {
      unsubscribeSessions();
      unsubscribeConnections();
      unsubscribeProfiles();
    };
  },
};
