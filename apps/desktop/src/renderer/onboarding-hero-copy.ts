/**
 * Pure copy + CTA mapping for `OnboardingHero` (PR110c).
 *
 * Extracted so the per-`OnboardingState.kind` branches can be unit-
 * tested without JSX / React. The hero component consumes this
 * helper and renders the matching structure.
 *
 * @kenji + @xuan PR110c review gates:
 *   - Every `OnboardingState.kind` has an explicit branch — no
 *     generic default. `blocked: all_connections_unhealthy` MUST
 *     produce a labeled fallback.
 *   - Copy is Chinese; raw `state.kind` strings MUST NOT appear in
 *     `title`, `body`, `cta.label`, or `eyebrow`.
 *   - For `needs_connection_credentials` / `needs_default_model`,
 *     `connectionSlug` may appear in the body as a slug literal but
 *     `connectionName` / model list must NOT be promised until
 *     sanitized display data is wired in a later PR.
 *   - `ready_with_history` returns `null` — the caller MUST NOT
 *     mount the hero for that state (the existing chat surface
 *     takes over). Since #1433 `ready_empty` returns `null` for the
 *     same reason: a configured user with no sessions is not an
 *     onboarding case and lands on the normal empty chat.
 */

import type { OnboardingState, SettingsSection, UiLocale } from '@maka/core';
import { getOnboardingCopy } from './locales/onboarding-copy.js';

export interface OnboardingHeroCopy {
  /** `OnboardingState.kind` echoed verbatim — useful for tests +
   * tooling. Never rendered to the user. */
  kind: OnboardingState['kind'];
  eyebrow: string;
  title: string;
  /**
   * Plain-text body. The actual hero component may render this with
   * inline emphasis / `<code>` for the slug; the test surface uses
   * the plain string.
   */
  body: string;
  /**
   * Slug to highlight in the body, if any (rendered as `<code>` by
   * the component). Currently only set for the two per-connection
   * variants. PR110c does NOT promise a `connectionName` — only the
   * raw slug literal.
   */
  connectionSlug?: string;
  cta: {
    label: string;
    settingsSection: SettingsSection;
  };
  tone?: 'warning' | 'destructive';
}

export type OnboardingSetupStepState = 'done' | 'active' | 'pending' | 'warning';

export interface OnboardingSetupStep {
  label: string;
  detail: string;
  state: OnboardingSetupStepState;
}

export function getOnboardingHeroCopy(state: OnboardingState, locale: UiLocale): OnboardingHeroCopy | null {
  const copy = getOnboardingCopy(locale);
  switch (state.kind) {
    case 'needs_connection':
      return { kind: state.kind, ...copy.hero.needs_connection };
    case 'needs_default_connection':
      return { kind: state.kind, ...copy.hero.needs_default_connection };
    case 'needs_connection_credentials':
      return {
        kind: state.kind,
        ...copy.hero.needs_connection_credentials,
        connectionSlug: state.connectionSlug,
      };
    case 'needs_default_model':
      return {
        kind: state.kind,
        ...copy.hero.needs_default_model,
        connectionSlug: state.connectionSlug,
      };
    case 'blocked':
      // `blocked.reason` is `'all_connections_unhealthy'` in PR110a's
      // closed enum. The labeled branch keeps the assertion explicit
      // — a future enum extension fails to compile rather than
      // silently fallthrough.
      void state.reason;
      return { kind: state.kind, ...copy.hero.blocked };
    case 'ready_empty':
    case 'ready_with_history':
      // The renderer caller decides which surface to mount; this
      // helper returning `null` is the explicit "do not render"
      // signal. The normal empty chat / session list takes over.
      return null;
    default:
      return assertNever(state);
  }
}

export function getOnboardingSetupSteps(
  state: OnboardingState,
  locale: UiLocale,
): readonly OnboardingSetupStep[] | null {
  const copy = getOnboardingCopy(locale);
  switch (state.kind) {
    case 'needs_connection':
      return copy.setupSteps.needs_connection;
    case 'needs_default_connection':
      return copy.setupSteps.needs_default_connection;
    case 'needs_connection_credentials':
      return copy.setupSteps.needs_connection_credentials;
    case 'needs_default_model':
      return copy.setupSteps.needs_default_model;
    case 'blocked':
      return copy.setupSteps.blocked;
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
