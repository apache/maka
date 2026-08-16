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
