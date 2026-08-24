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

// apps/desktop/src/renderer/onboarding-hero.tsx
//
// First-run recovery rendered in place of the empty chat while setup is
// incomplete. The core state machine owns what is missing; this component
// shows only the shortest next action. Provider configuration remains owned
// by Settings, and a ready workspace returns to the ordinary Composer.

import { type LlmConnection, type ProviderType } from '@maka/core/llm-connections';

import { type OnboardingState } from '@maka/core/onboarding';

import { type SettingsSection } from '@maka/core/settings';
import { Button, MakaWordmark, useUiLocale } from '@maka/ui';
import { ICON_SIZE, AlertCircle, ChevronRight, Cpu, KeyRound } from '@maka/ui/icons';
import {
  Banner,
  Card,
  Center,
  Code,
  Heading,
  HStack,
  List,
  ListItem,
  Text,
  VStack,
} from '@astryxdesign/core';
import type { ReactNode } from 'react';
import { getOnboardingCopy } from './locales/onboarding-copy';
import { getOnboardingHeroCopy, type OnboardingHeroCopy } from './onboarding-hero-copy';
import { ProviderLogo, providerDisplay } from './settings/provider-display';
import { FIRST_RUN_PROVIDER_TYPES } from './onboarding-provider-types';

export interface OnboardingHeroProps {
  state: OnboardingState;
  /** Open Settings with a specific section preselected. */
  onOpenSettings: (section?: SettingsSection) => void;
  /** Open the detail route for the connection that needs recovery. */
  onOpenConnectionDetail: (connectionSlug: string) => void;
  /** Open Settings → Models with setup focused on this provider. */
  onAddProvider: (providerType: ProviderType) => void;
  /** Open the shared Settings provider catalog. */
  onBrowseProviders: () => void;
  /** Resolve a state slug to a human-friendly label when possible. */
  connections?: ReadonlyArray<LlmConnection>;
  /** Re-query setup state after an out-of-band configuration change. */
  onRefreshConnections?: () => Promise<void> | void;
  /** Permanently skip the initial guide and enter the app. */
  onSkip?: () => Promise<void> | void;
}

export function OnboardingHero(props: OnboardingHeroProps) {
  const { state } = props;
  switch (state.kind) {
    case 'needs_connection':
      return (
        <NeedsConnectionCard
          onAddProvider={props.onAddProvider}
          onBrowseProviders={props.onBrowseProviders}
          onRefreshConnections={props.onRefreshConnections}
          onSkip={props.onSkip}
        />
      );
    case 'needs_connection_credentials':
      return (
        <RecoveryCard
          state={state}
          icon={<KeyRound size={ICON_SIZE.control} aria-hidden="true" />}
          connection={connectionLabel(state.connectionSlug, props.connections)}
          {...recoveryCallbacks(props)}
        />
      );
    case 'needs_model':
      return (
        <RecoveryCard
          state={state}
          icon={<Cpu size={ICON_SIZE.control} aria-hidden="true" />}
          connection={connectionLabel(state.connectionSlug, props.connections)}
          {...recoveryCallbacks(props)}
        />
      );
    case 'blocked':
      acknowledgeBlockedReason(state.reason);
      return (
        <RecoveryCard
          state={state}
          icon={<AlertCircle size={ICON_SIZE.control} aria-hidden="true" />}
          {...recoveryCallbacks(props)}
        />
      );
    case 'ready_empty':
    case 'ready_with_history':
      return null;
    default:
      return assertNever(state);
  }
}

function recoveryCallbacks(props: OnboardingHeroProps) {
  return {
    onOpenSettings: props.onOpenSettings,
    onOpenConnectionDetail: props.onOpenConnectionDetail,
    onBrowseProviders: props.onBrowseProviders,
    onRefreshConnections: props.onRefreshConnections,
    onSkip: props.onSkip,
  };
}

function connectionLabel(
  slug: string,
  connections?: ReadonlyArray<LlmConnection>,
): { name: string; isFallback: boolean } {
  const match = connections?.find((connection) => connection.slug === slug);
  return match?.name
    ? { name: match.name, isFallback: false }
    : { name: slug, isFallback: true };
}

function NeedsConnectionCard(props: {
  onAddProvider: (providerType: ProviderType) => void;
  onBrowseProviders: () => void;
  onRefreshConnections?: () => Promise<void> | void;
  onSkip?: () => Promise<void> | void;
}) {
  const locale = useUiLocale();
  const copy = getOnboardingCopy(locale);
  const hero = getOnboardingHeroCopy({ kind: 'needs_connection' }, locale);
  if (!hero) return null;

  return (
    <OnboardingCard
      label={hero.eyebrow}
      eyebrow={hero.eyebrow}
      title={hero.title}
      body={hero.body}
      onSkip={props.onSkip}
    >
      <VStack gap={3} width="100%" className="maka-onboarding-provider-group">
        <Text weight="medium">{copy.needsConnection.pickLabel}</Text>
        <List hasDividers density="balanced" className="maka-onboarding-provider-list">
          {FIRST_RUN_PROVIDER_TYPES.map((type) => {
            const display = providerDisplay(type, locale);
            return (
              <ListItem
                key={type}
                className="maka-onboarding-provider-row"
                data-provider={type}
                startContent={<ProviderLogo type={type} compact />}
                label={display.name}
                description={display.description}
                endContent={<ChevronRight size={ICON_SIZE.chrome} aria-hidden="true" />}
                onClick={() => props.onAddProvider(type)}
              />
            );
          })}
        </List>
        <VStack gap={1.5} width="100%">
          <Button
            variant="secondary"
            size="lg"
            width="100%"
            onClick={props.onBrowseProviders}
            label={copy.needsConnection.browseProviders}
          />
          {props.onRefreshConnections && (
            <Button
              variant="ghost"
              width="100%"
              clickAction={async () => props.onRefreshConnections?.()}
              label={copy.refresh.connection}
            />
          )}
        </VStack>
      </VStack>
    </OnboardingCard>
  );
}

type RecoveryState = Exclude<
  OnboardingState,
  { kind: 'needs_connection' | 'ready_empty' | 'ready_with_history' }
>;

function RecoveryCard(props: {
  state: RecoveryState;
  icon: ReactNode;
  connection?: { name: string; isFallback: boolean };
  onOpenSettings: (section?: SettingsSection) => void;
  onOpenConnectionDetail: (connectionSlug: string) => void;
  onBrowseProviders: () => void;
  onRefreshConnections?: () => Promise<void> | void;
  onSkip?: () => Promise<void> | void;
}) {
  const locale = useUiLocale();
  const copy = getOnboardingCopy(locale);
  const hero = getOnboardingHeroCopy(props.state, locale);
  if (!hero) return null;

  return (
    <OnboardingCard
      label={hero.eyebrow}
      eyebrow={hero.eyebrow}
      icon={props.icon}
      title={hero.title}
      body={(
        <>
          {hero.body}
          {props.connection && (
            <>
              {' '}{copy.connectionLabel}:{' '}
              {props.connection.isFallback ? (
                <Code>{props.connection.name}</Code>
              ) : (
                <strong>{props.connection.name}</strong>
              )}
            </>
          )}
        </>
      )}
      tone={hero.tone}
      onSkip={props.onSkip}
    >
      <VStack gap={1.5} width="100%" className="maka-onboarding-actions">
        <Button
          variant="primary"
          size="lg"
          width="100%"
          data-connection-slug={hero.cta.target.kind === 'connection'
            ? hero.cta.target.connectionSlug
            : undefined}
          onClick={() => activateTarget(hero.cta.target, props)}
          label={hero.cta.label}
        />
        {props.onRefreshConnections && (
          <Button
            variant="ghost"
            width="100%"
            clickAction={async () => props.onRefreshConnections?.()}
            label={refreshLabel(props.state, copy)}
          />
        )}
      </VStack>
    </OnboardingCard>
  );
}

function activateTarget(
  target: OnboardingHeroCopy['cta']['target'],
  callbacks: {
    onOpenSettings: (section?: SettingsSection) => void;
    onOpenConnectionDetail: (connectionSlug: string) => void;
    onBrowseProviders: () => void;
  },
) {
  switch (target.kind) {
    case 'provider_catalog':
      callbacks.onBrowseProviders();
      return;
    case 'models':
      callbacks.onOpenSettings('models');
      return;
    case 'connection':
      callbacks.onOpenConnectionDetail(target.connectionSlug);
      return;
    default:
      return assertNever(target);
  }
}

function refreshLabel(state: RecoveryState, copy: ReturnType<typeof getOnboardingCopy>) {
  switch (state.kind) {
    case 'needs_connection_credentials':
      return copy.refresh.credentials;
    case 'needs_model':
      return copy.refresh.model;
    case 'blocked':
      return copy.refresh.blocked;
    default:
      return assertNever(state);
  }
}

function OnboardingCard(props: {
  label: string;
  eyebrow: string;
  icon?: ReactNode;
  title: string;
  body: ReactNode;
  tone?: 'destructive';
  onSkip?: () => Promise<void> | void;
  children: ReactNode;
}) {
  const copy = getOnboardingCopy(useUiLocale());
  return (
    <Center width="100%" className="maka-onboarding-center">
      <VStack gap={4} hAlign="center" width="min(460px, 100%)" className="maka-onboarding">
        <MakaWordmark width={112} className="maka-onboarding-wordmark" />
        <Card
          width="100%"
          padding={6}
          className="maka-onboarding-card"
          data-maka-contract="onboarding-card"
        >
          <VStack as="section" gap={5} width="100%" aria-label={props.label}>
            <VStack gap={2} width="100%" className="maka-onboarding-header">
              {props.tone === 'destructive' ? (
                <Banner status="error" title={props.eyebrow} />
              ) : (
                <HStack gap={1.5} vAlign="center">
                  {props.icon}
                  <Text type="supporting" color="secondary">{props.eyebrow}</Text>
                </HStack>
              )}
              <Heading level={1}>{props.title}</Heading>
              <Text color="secondary">{props.body}</Text>
            </VStack>
            {props.children}
          </VStack>
        </Card>
        {props.onSkip && (
          <Button
            variant="ghost"
            clickAction={async () => props.onSkip?.()}
            label={copy.skip}
          />
        )}
      </VStack>
    </Center>
  );
}

function assertNever(value: never): never {
  void value;
  throw new Error('OnboardingHero: unexhausted state');
}

// Listed as literals rather than the reason type: a future reason still has to
// be added here, which is the point — it forces a look at whether this card
// needs to react to it.
function acknowledgeBlockedReason(
  reason: 'all_connections_unhealthy' | 'all_connections_retired',
) {
  void reason;
}
