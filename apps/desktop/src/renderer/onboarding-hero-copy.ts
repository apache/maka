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
import { getOnboardingCopy } from './locales/onboarding-copy.js';

export type OnboardingActionTarget =
  | { kind: 'provider_catalog' }
  | { kind: 'models' }
  | { kind: 'connection'; connectionSlug: string };

export interface OnboardingHeroCopy {
  /** Echoed for tests and tooling; never rendered as user copy. */
  kind: OnboardingState['kind'];
  eyebrow: string;
  title: string;
  body: string;
  connectionSlug?: string;
  cta: {
    label: string;
    target: OnboardingActionTarget;
  };
  tone?: 'destructive';
}

/**
 * The renderer view model for the one action that unblocks each onboarding
 * state. Ready states deliberately return null so the ordinary empty chat or
 * session history takes over.
 */
export function getOnboardingHeroCopy(
  state: OnboardingState,
  locale: UiLocale,
): OnboardingHeroCopy | null {
  const copy = getOnboardingCopy(locale);
  switch (state.kind) {
    case 'needs_connection':
      return {
        kind: state.kind,
        ...copy.hero.needs_connection,
        cta: { ...copy.hero.needs_connection.cta, target: { kind: 'provider_catalog' } },
      };
    case 'needs_connection_credentials':
      return {
        kind: state.kind,
        ...copy.hero.needs_connection_credentials,
        connectionSlug: state.connectionSlug,
        cta: {
          ...copy.hero.needs_connection_credentials.cta,
          target: { kind: 'connection', connectionSlug: state.connectionSlug },
        },
      };
    case 'needs_model':
      return {
        kind: state.kind,
        ...copy.hero.needs_model,
        connectionSlug: state.connectionSlug,
        cta: {
          ...copy.hero.needs_model.cta,
          target: { kind: 'connection', connectionSlug: state.connectionSlug },
        },
      };
    case 'blocked': {
      // Retirement gets its own copy: the generic text tells the user to
      // re-check credentials and sign-in, and for a retired provider both of
      // those lead nowhere.
      const blocked = copy.hero[`blocked:${state.reason}`];
      return {
        kind: state.kind,
        ...blocked,
        cta: { ...blocked.cta, target: { kind: 'models' } },
      };
    }
    case 'ready_empty':
    case 'ready_with_history':
      return null;
    default:
      return assertNever(state);
  }
}

function assertNever(state: never): never {
  void state;
  throw new Error('getOnboardingHeroCopy: unexhausted OnboardingState variant');
}
