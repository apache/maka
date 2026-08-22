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

import type { OnboardingState } from '@maka/core/onboarding';
import type { UiLocale } from '@maka/core/ui-locale';
import {
  getOnboardingHeroCopy,
  type OnboardingActionTarget,
} from './onboarding-hero-copy.js';

export interface WorkspaceReadinessRecovery {
  tone: 'warning' | 'destructive';
  title: string;
  description: string;
  actionLabel: string;
  target: OnboardingActionTarget;
}

/**
 * Keeps setup failures recoverable after the one-time onboarding surface has
 * been dismissed. Active sessions have their own, more specific health
 * projection, so this notice only owns the new-task workspace state.
 */
export function deriveWorkspaceReadinessRecovery(input: {
  state: OnboardingState | undefined;
  locale: UiLocale;
  activeSessionId: string | undefined;
  showOnboardingHero: boolean;
}): WorkspaceReadinessRecovery | undefined {
  if (!input.state || input.activeSessionId || input.showOnboardingHero) return undefined;

  const copy = getOnboardingHeroCopy(input.state, input.locale);
  if (!copy) return undefined;

  return {
    tone: copy.tone === 'destructive' ? 'destructive' : 'warning',
    title: copy.title,
    description: copy.body,
    actionLabel: copy.cta.label,
    target: copy.cta.target,
  };
}
