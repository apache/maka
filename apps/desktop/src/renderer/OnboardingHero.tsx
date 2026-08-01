// apps/desktop/src/renderer/OnboardingHero.tsx
//
// Setup hero rendered in place of the chat surface when the workspace
// has no sessions yet AND the provider setup is incomplete (PR110c
// rewrite). Routes purely off the `OnboardingState` projection from
// `@maka/core/onboarding` — never re-derives provider readiness, never
// lists connections directly.
//
// A configured user is not an onboarding case: `ready_empty` and
// `ready_with_history` both render nothing here and land on the normal
// empty chat with the one real Composer.
//
// @kenji + @xuan PR110c review gates:
//   - Each `OnboardingState.kind` has an explicit branch with a
//     diagnostic Chinese copy + Settings deep-link CTA. NO inline
//     editors (credential entry / model picker live in Settings).
//   - `blocked: all_connections_unhealthy` MUST have a labeled
//     fallback branch — no generic `default` swallowing it.
//   - `ready_with_history` MUST NOT render this hero (caller decides).
//   - Raw `state.kind` strings MUST NOT appear in rendered text;
//     copy is in Chinese with no enum identifier leakage.
//   - For `needs_connection_credentials` / `needs_default_model`,
//     `connectionSlug` is shown as a slug literal (no
//     `connectionName` promise) until sanitized display data is
//     wired in a later PR.

import { ChevronRight, KeyRound, Settings as SettingsIcon, Cpu, AlertCircle } from '@maka/ui/icons';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { RECOMMENDED_PROVIDER_TYPES, type LlmConnection, type OnboardingState, type ProviderType, type SettingsSection } from '@maka/core';
import {
  Button,
  useMountedRef,
  useUiLocale,
} from '@maka/ui';
import { Item } from '@astryxdesign/core/Item';
import { ProviderLogo, providerDisplay } from './settings/provider-display';
import { getOnboardingHeroCopy, getOnboardingSetupSteps, type OnboardingSetupStep } from './onboarding-hero-copy';
import { getOnboardingCopy } from './locales/onboarding-copy';

export interface OnboardingHeroProps {
  state: OnboardingState;
  /** Open Settings with a specific section preselected. */
  onOpenSettings: (section?: SettingsSection) => void;
  /** Open Settings → 模型 with the create-connection dialog for this provider. */
  onAddProvider: (providerType: ProviderType) => void;
  /** Open the shared Settings provider catalog. */
  onBrowseProviders: () => void;
  /**
   * PR-ONBOARDING-EARLY-COPY-0: current connection list so the
   * credentials / model heroes can resolve a `connectionSlug` to a
   * human-friendly name. Optional; falls back to slug if missing.
   */
  connections?: ReadonlyArray<LlmConnection>;
  /**
   * PR-ONBOARDING-EARLY-COPY-0: refresh handler so env-bootstrap
   * users who finished their setup outside the UI can re-query
   * the snapshot without restarting. Optional.
   */
  onRefreshConnections?: () => Promise<void> | void;
  /**
   * Skip the initial onboarding and enter the app. Writes
   * `initial_onboarding` milestone as `skipped`. Every branch this
   * hero still renders is a setup branch, so the skip affordance is
   * always meaningful.
   */
  onSkip?: () => Promise<void> | void;
}

export function OnboardingHero(props: OnboardingHeroProps) {
  const { state } = props;
  const [refreshConnectionsPending, setRefreshConnectionsPending] = useState(false);
  const onboardingMountedRef = useMountedRef();
  const refreshConnectionsPendingRef = useRef(false);

  useEffect(() => {
    return () => {
      refreshConnectionsPendingRef.current = false;
    };
  }, []);

  const runRefreshConnections = useCallback(async () => {
    if (!props.onRefreshConnections || refreshConnectionsPendingRef.current) return;
    refreshConnectionsPendingRef.current = true;
    setRefreshConnectionsPending(true);
    try {
      await props.onRefreshConnections();
    } finally {
      refreshConnectionsPendingRef.current = false;
      if (onboardingMountedRef.current) setRefreshConnectionsPending(false);
    }
  }, [props.onRefreshConnections]);

  switch (state.kind) {
    case 'needs_connection':
      return (
        <NeedsConnectionHero
          onAddProvider={props.onAddProvider}
          onBrowseProviders={props.onBrowseProviders}
          onRefreshConnections={props.onRefreshConnections ? runRefreshConnections : undefined}
          refreshConnectionsPending={refreshConnectionsPending}
          onSkip={props.onSkip}
        />
      );
    case 'needs_default_connection':
      return (
        <NeedsDefaultConnectionHero
          onOpenSettings={props.onOpenSettings}
          onRefreshConnections={props.onRefreshConnections ? runRefreshConnections : undefined}
          refreshConnectionsPending={refreshConnectionsPending}
          onSkip={props.onSkip}
        />
      );
    case 'needs_connection_credentials':
      return (
        <NeedsConnectionCredentialsHero
          connectionSlug={state.connectionSlug}
          connections={props.connections}
          onOpenSettings={props.onOpenSettings}
          onRefreshConnections={props.onRefreshConnections ? runRefreshConnections : undefined}
          refreshConnectionsPending={refreshConnectionsPending}
          onSkip={props.onSkip}
        />
      );
    case 'needs_default_model':
      return (
        <NeedsDefaultModelHero
          connectionSlug={state.connectionSlug}
          connections={props.connections}
          onOpenSettings={props.onOpenSettings}
          onRefreshConnections={props.onRefreshConnections ? runRefreshConnections : undefined}
          refreshConnectionsPending={refreshConnectionsPending}
          onSkip={props.onSkip}
        />
      );
    case 'ready_empty':
      // A configured user with no sessions yet gets the daily empty
      // chat — wordmark hero plus the one real Composer — not a
      // first-run chat panel of its own. This branch used to render
      // `ReadyEmptyHero`, a second composer that re-implemented the
      // textarea, the `/` mention popup, Skill chips, file import and
      // the IME composition guard, and drifted from the real one
      // (`PR-FE-BUG-HUNT-0`: Enter committed an unfinished IME
      // composition). The caller gates on this the same way it gates
      // `ready_with_history`; rendering nothing here is the fallback.
      return null;
    case 'blocked':
      // `blocked.reason` is `'all_connections_unhealthy'` in PR110a's
      // closed enum; if a future PR extends it, this assignment will
      // fail to compile (assertNever), forcing a labeled branch
      // rather than a silent fallthrough.
      return (
        <BlockedHero
          reason={state.reason}
          onOpenSettings={props.onOpenSettings}
          onRefreshConnections={props.onRefreshConnections ? runRefreshConnections : undefined}
          refreshConnectionsPending={refreshConnectionsPending}
          onSkip={props.onSkip}
        />
      );
    case 'ready_with_history':
      // The renderer caller decides which hero to render; this
      // component is only mounted when sessions.length === 0. Showing
      // ready_with_history at all means the caller bypassed the gate
      // — render nothing so the existing chat surface takes over.
      return null;
    default:
      return assertNever(state);
  }
}

/**
 * PR-ONBOARDING-EARLY-COPY-0: resolve a slug to its persisted
 * connection name. Falls back to the raw slug when the lookup misses
 * (e.g. snapshot raced ahead of the connection list refresh).
 */
function connectionLabel(
  slug: string,
  connections?: ReadonlyArray<LlmConnection>,
): { name: string; isFallback: boolean } {
  if (!connections) return { name: slug, isFallback: true };
  const match = connections.find((c) => c.slug === slug);
  if (!match || !match.name) return { name: slug, isFallback: true };
  return { name: match.name, isFallback: false };
}

function NeedsConnectionHero(props: {
  onAddProvider: (providerType: ProviderType) => void;
  onBrowseProviders: () => void;
  onRefreshConnections?: () => void;
  refreshConnectionsPending?: boolean;
  onSkip?: () => Promise<void> | void;
}) {
  const locale = useUiLocale();
  const copy = getOnboardingCopy(locale);
  const hero = getOnboardingHeroCopy({ kind: 'needs_connection' }, locale)!;
  const setupSteps = getOnboardingSetupSteps({ kind: 'needs_connection' }, locale);
  return (
    <section className="maka-onboarding maka-firstrun" aria-label={hero.eyebrow}>
      {/* Selection-led layout: a big title sets the hierarchy, the three
          setup steps compress to one quiet stepper line (context, not the
          subject), and the provider list is the clear primary action. */}
      <h1 className="maka-firstrun-title">{hero.title}</h1>
      <p className="maka-firstrun-sub">{copy.needsConnection.subtitle}</p>

      {setupSteps && <FirstRunStepper steps={setupSteps} />}

      <div className="maka-firstrun-pick">
        <span className="maka-firstrun-pick-label">{copy.needsConnection.pickLabel}</span>
        <span className="maka-firstrun-pick-hint">{copy.needsConnection.pickHint}</span>
      </div>

      {/* The list scrolls vertically (CSS max-height) so it scales as more
          providers are added without pushing the footer off-screen. */}
      <div className="maka-firstrun-list">
        <ul role="list">
          {RECOMMENDED_PROVIDER_TYPES.map((type) => {
            const display = providerDisplay(type, locale);
            return (
              <li key={type}>
                <Item
                  className="maka-firstrun-row px-3.5 py-2"
                  startContent={<ProviderLogo type={type} compact />}
                  label={display.name}
                  description={display.description}
                  endContent={<ChevronRight size={16} aria-hidden="true" />}
                  onClick={() => props.onAddProvider(type)}
                />
              </li>
            );
          })}
        </ul>
      </div>

      {/* Designer audit P2-15: the footer's primary 打开设置·模型 button
          duplicated what clicking any provider row above already does (the
          list header even says 点一个进入设置). One affordance per action —
          the footer keeps only genuinely distinct paths. */}
      <footer
        className="maka-onboarding-footer"
        data-maka-contract="onboarding-actions"
      >
        <Button variant="secondary" onClick={props.onBrowseProviders} label={copy.needsConnection.browseProviders} />
        {props.onRefreshConnections && (
          <Button
            variant="secondary"
            onClick={props.onRefreshConnections}
            isDisabled={props.refreshConnectionsPending === true}
            aria-busy={props.refreshConnectionsPending === true ? 'true' : undefined}
            label={props.refreshConnectionsPending === true ? copy.refresh.pending : copy.refresh.connection}
          />
        )}
        {props.onSkip && <SkipButton onSkip={props.onSkip} />}
      </footer>
    </section>
  );
}

/**
 * Compact "where you are" stepper for the first-run hero: numbered nodes
 * joined by connectors, the active step lit with the brand accent and the
 * rest outlined. Stays one quiet line so the provider list keeps the lead.
 */
function FirstRunStepper({ steps }: { steps: readonly OnboardingSetupStep[] }) {
  const copy = getOnboardingCopy(useUiLocale());
  return (
    <ol className="maka-firstrun-stepper" aria-label={copy.setupProgressLabel}>
      {steps.map((step, index) => (
        <Fragment key={`${step.label}-${index}`}>
          {index > 0 && <li className="maka-firstrun-step-line" aria-hidden="true" />}
          <li className="maka-firstrun-step" data-state={step.state}>
            <span className="maka-firstrun-step-dot" aria-hidden="true">{index + 1}</span>
            <span className="maka-firstrun-step-label">{step.label}</span>
          </li>
        </Fragment>
      ))}
    </ol>
  );
}

function NeedsDefaultConnectionHero(props: {
  onOpenSettings: (section?: SettingsSection) => void;
  onRefreshConnections?: () => void;
  refreshConnectionsPending?: boolean;
  onSkip?: () => Promise<void> | void;
}) {
  const locale = useUiLocale();
  const copy = getOnboardingCopy(locale);
  const hero = getOnboardingHeroCopy({ kind: 'needs_default_connection' }, locale)!;
  return (
    <SetupHero
      icon={<SettingsIcon size={14} aria-hidden="true" />}
      eyebrow={hero.eyebrow}
      title={hero.title}
      body={hero.body}
      setupSteps={getOnboardingSetupSteps({ kind: 'needs_default_connection' }, locale)}
      primaryCta={{ label: hero.cta.label, onClick: () => props.onOpenSettings(hero.cta.settingsSection) }}
      secondaryCta={
        props.onRefreshConnections
          ? {
            label: props.refreshConnectionsPending === true ? copy.refresh.pending : copy.refresh.connection,
            onClick: props.onRefreshConnections,
            disabled: props.refreshConnectionsPending === true,
            busy: props.refreshConnectionsPending === true,
          }
          : undefined
      }
      onSkip={props.onSkip}
    />
  );
}

function NeedsConnectionCredentialsHero(props: {
  connectionSlug: string;
  connections?: ReadonlyArray<LlmConnection>;
  onOpenSettings: (section?: SettingsSection) => void;
  onRefreshConnections?: () => void;
  refreshConnectionsPending?: boolean;
  onSkip?: () => Promise<void> | void;
}) {
  const locale = useUiLocale();
  const copy = getOnboardingCopy(locale);
  const state = { kind: 'needs_connection_credentials', connectionSlug: props.connectionSlug } as const;
  const hero = getOnboardingHeroCopy(state, locale)!;
  const { name, isFallback } = connectionLabel(props.connectionSlug, props.connections);
  return (
    <SetupHero
      icon={<KeyRound size={14} aria-hidden="true" />}
      eyebrow={hero.eyebrow}
      title={hero.title}
      body={
        <>
          {hero.body} {copy.connectionLabel}:{' '}
          {isFallback ? (
            <code className="maka-onboarding-slug">{name}</code>
          ) : (
            <strong>{name}</strong>
          )}
        </>
      }
      setupSteps={getOnboardingSetupSteps(state, locale)}
      primaryCta={{ label: hero.cta.label, onClick: () => props.onOpenSettings(hero.cta.settingsSection) }}
      secondaryCta={
        props.onRefreshConnections
          ? {
            label: props.refreshConnectionsPending === true ? copy.refresh.pending : copy.refresh.credentials,
            onClick: props.onRefreshConnections,
            disabled: props.refreshConnectionsPending === true,
            busy: props.refreshConnectionsPending === true,
          }
          : undefined
      }
      onSkip={props.onSkip}
    />
  );
}

function NeedsDefaultModelHero(props: {
  connectionSlug: string;
  connections?: ReadonlyArray<LlmConnection>;
  onOpenSettings: (section?: SettingsSection) => void;
  onRefreshConnections?: () => void;
  refreshConnectionsPending?: boolean;
  onSkip?: () => Promise<void> | void;
}) {
  const locale = useUiLocale();
  const copy = getOnboardingCopy(locale);
  const state = { kind: 'needs_default_model', connectionSlug: props.connectionSlug } as const;
  const hero = getOnboardingHeroCopy(state, locale)!;
  const { name, isFallback } = connectionLabel(props.connectionSlug, props.connections);
  return (
    <SetupHero
      icon={<Cpu size={14} aria-hidden="true" />}
      eyebrow={hero.eyebrow}
      title={hero.title}
      body={
        <>
          {hero.body} {copy.connectionLabel}:{' '}
          {isFallback ? (
            <code className="maka-onboarding-slug">{name}</code>
          ) : (
            <strong>{name}</strong>
          )}
        </>
      }
      setupSteps={getOnboardingSetupSteps(state, locale)}
      primaryCta={{ label: hero.cta.label, onClick: () => props.onOpenSettings(hero.cta.settingsSection) }}
      secondaryCta={
        props.onRefreshConnections
          ? {
            label: props.refreshConnectionsPending === true ? copy.refresh.pending : copy.refresh.model,
            onClick: props.onRefreshConnections,
            disabled: props.refreshConnectionsPending === true,
            busy: props.refreshConnectionsPending === true,
          }
          : undefined
      }
      onSkip={props.onSkip}
    />
  );
}

function BlockedHero(props: {
  reason: 'all_connections_unhealthy';
  onOpenSettings: (section?: SettingsSection) => void;
  onRefreshConnections?: () => void;
  refreshConnectionsPending?: boolean;
  onSkip?: () => Promise<void> | void;
}) {
  // The reason is destructured to satisfy exhaustive type-checking;
  // when PR-future extends the enum, this branch must update too.
  void props.reason;
  const locale = useUiLocale();
  const copy = getOnboardingCopy(locale);
  const state = { kind: 'blocked', reason: props.reason } as const;
  const hero = getOnboardingHeroCopy(state, locale)!;
  return (
    <SetupHero
      icon={<AlertCircle size={14} aria-hidden="true" />}
      eyebrow={hero.eyebrow}
      title={hero.title}
      body={hero.body}
      setupSteps={getOnboardingSetupSteps(state, locale)}
      primaryCta={{ label: hero.cta.label, onClick: () => props.onOpenSettings(hero.cta.settingsSection) }}
      secondaryCta={
        props.onRefreshConnections
          ? {
            label: props.refreshConnectionsPending === true ? copy.refresh.pending : copy.refresh.blocked,
            onClick: props.onRefreshConnections,
            disabled: props.refreshConnectionsPending === true,
            busy: props.refreshConnectionsPending === true,
          }
          : undefined
      }
      onSkip={props.onSkip}
      // PR-UI-LAYOUT-25: 'destructive' (vs the previous 'warning') so
      // the user sees "all connections unhealthy" at full gravity —
      // distinct from "missing default model" or "needs reauth" which
      // are recoverable yellow states.
      tone="destructive"
    />
  );
}

function SkipButton(props: { onSkip: () => Promise<void> | void; label?: string }) {
  const copy = getOnboardingCopy(useUiLocale());
  const [pending, setPending] = useState(false);
  const mountedRef = useMountedRef();
  const onClick = useCallback(async () => {
    if (pending) return;
    setPending(true);
    try {
      await props.onSkip();
    } finally {
      if (mountedRef.current) setPending(false);
    }
  }, [pending, props]);
  return (
    <Button
      variant="secondary"
      onClick={onClick}
      isDisabled={pending}
      aria-busy={pending ? 'true' : undefined}
      label={pending ? copy.skipping : (props.label ?? copy.skip)}
    />
  );
}

interface SetupHeroProps {
  icon: React.ReactNode;
  eyebrow: string;
  title: string;
  body: React.ReactNode;
  setupSteps?: readonly OnboardingSetupStep[] | null;
  primaryCta: { label: string; onClick: () => void };
  /**
   * PR-ONBOARDING-EARLY-COPY-0: optional ghost-style secondary action
   * sitting next to the primary CTA. Used by the early-onboarding
   * branches to expose a "已经配好了？刷新检测" affordance so a user
   * with env-bootstrap connections is not stuck behind a stale
   * snapshot. Hidden when not provided so existing call sites are
   * unchanged.
   */
  secondaryCta?: { label: string; onClick: () => void; disabled?: boolean; busy?: boolean };
  /**
   * Optional skip affordance for the `needs_*` / `blocked` branches.
   * Renders as a ghost button after the secondary CTA. Lets the user
   * enter the app without configuring a provider.
   */
  onSkip?: () => Promise<void> | void;
  /**
   * PR-UI-LAYOUT-25 (@yuejing 2026-05-22): extended from `'warning'`
   * only to also accept `'destructive'` so a blocked-state hero
   * ("all_connections_unhealthy") reads with genuine gravity
   * instead of "yellow warning". CSS rules for
   * `.maka-onboarding-setup[data-tone="destructive"]` paint the
   * eyebrow + headline in destructive tone.
   */
  tone?: 'warning' | 'destructive';
}

function SetupHero(props: SetupHeroProps) {
  return (
    <section
      className="maka-onboarding maka-onboarding-setup"
      data-tone={props.tone}
      aria-label={props.eyebrow}
    >
      <header>
        <span className="maka-onboarding-eyebrow">
          {props.icon}
          <span>{props.eyebrow}</span>
        </span>
        <h1>{props.title}</h1>
        <p>{props.body}</p>
      </header>
      {props.setupSteps && <SetupProgress steps={props.setupSteps} />}
      <footer
        className="maka-onboarding-footer"
        data-maka-contract="onboarding-actions"
      >
        <Button
          variant="primary"
          onClick={props.primaryCta.onClick}
          label={props.primaryCta.label}
        />
        {props.secondaryCta && (
          <Button
            variant="secondary"
            onClick={props.secondaryCta.onClick}
            isDisabled={props.secondaryCta.disabled === true}
            aria-busy={props.secondaryCta.busy === true ? 'true' : undefined}
            label={props.secondaryCta.label}
          />
        )}
        {props.onSkip && <SkipButton onSkip={props.onSkip} />}
      </footer>
    </section>
  );
}

function SetupProgress(props: { steps: readonly OnboardingSetupStep[] }) {
  const copy = getOnboardingCopy(useUiLocale());
  return (
    <ol className="maka-onboarding-setup-steps" aria-label={copy.setupProgressLabel}>
      {props.steps.map((step, index) => (
        <li key={`${step.label}-${index}`} data-state={step.state}>
          <span className="maka-onboarding-setup-step-marker" aria-hidden="true">
            {index + 1}
          </span>
          <span className="maka-onboarding-setup-step-copy">
            <strong>{step.label}</strong>
            <small>{step.detail}</small>
          </span>
          <span className="maka-onboarding-setup-step-state">
            {copy.setupStatus[step.state]}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Exhaustive switch helper. If `OnboardingState` ever grows a new
 * variant without a matching `case`, this call site fails to compile
 * — preventing a silent fallthrough that would render no hero or a
 * generic placeholder for the missing state.
 */
function assertNever(state: never): never {
  // The runtime fallback should never execute. We still log a
  // generalized error class (no raw `state.kind` leak) to surface the
  // gap in dev builds without breaking the chat surface.
  void state;
  throw new Error('OnboardingHero: unexhausted OnboardingState variant');
}
