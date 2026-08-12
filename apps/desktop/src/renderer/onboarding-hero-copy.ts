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
    case 'blocked':
      acknowledgeBlockedReason(state.reason);
      return {
        kind: state.kind,
        ...copy.hero.blocked,
        cta: { ...copy.hero.blocked.cta, target: { kind: 'models' } },
      };
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

function acknowledgeBlockedReason(reason: 'all_connections_unhealthy') {
  void reason;
}
