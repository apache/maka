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

import {
  Banner,
  EmptyState,
  Heading,
  HStack,
  List,
  ListItem,
  VStack,
} from '@astryxdesign/core';
import { ICON_SIZE, Check, ChevronRight, Search } from '@maka/ui/icons';
import {
  CATALOG_PROVIDER_TYPES,
  RECOMMENDED_PROVIDER_TYPES,
  type ProviderCatalogGroup,
  type ProviderType,
} from '@maka/core/provider-registry';
import { PROVIDER_REGISTRY, type LlmConnection } from '@maka/core/llm-connections';
import type { UiLocale } from '@maka/core/ui-locale';
import { Button, TextInput, useUiLocale } from '@maka/ui';
import { AddProviderForm } from './provider-add-form';
import { ProviderLogo, providerDisplay } from './provider-display';
import { OAuthLoginPanel, useOAuthCards, type OAuthCard, type OAuthCardId } from './provider-oauth-section';
import {
  getProviderSettingsCopy,
  type ApiKeyOnboardingBridge,
  type ConnectionsBridge,
  type DesktopConnectionOnboardingIdentity,
} from '../features/connection-settings';

/**
 * How the catalog is filtered. It lives in the panel, not in this component:
 * picking a provider navigates away and unmounts the catalog, and a search the
 * user typed should still be there when they come back.
 */
export interface CatalogFilter {
  query: string;
}

export const CATALOG_INITIAL_FILTER: CatalogFilter = { query: '' };

export interface CreatedOAuthConnectionIdentity {
  connectionId: string;
  slug: string;
  providerType: 'openai-codex' | 'xai-oauth' | 'github-copilot';
}

/**
 * One provider being set up. `credentials` is a form, `account` is a browser
 * login — two bodies of one level, not two levels: they are reached the same
 * way and they go back to the same place.
 */
export type SetupTarget =
  | { method: 'credentials'; providerType: ProviderType; name: string }
  | { method: 'account'; cardId: OAuthCardId; providerType: ProviderType; name: string };

/** The catalog groups in page order; `recommended` also carries the account sign-ins. */
const CATALOG_GROUPS: readonly ProviderCatalogGroup[] = ['recommended', 'plans', 'api', 'aggregators', 'local'];

/**
 * Level 2: the provider catalog. One search field over everything, and below
 * it the providers as labeled groups — the same 推荐 / 订阅计划 / API / 聚合
 * / 本地 vocabulary the registry already carries, laid out the way every other
 * settings page lays out its groups. A category picker used to stand beside
 * the search field; the groups make it redundant, because scrolling past a
 * heading is the filter.
 *
 * Typing collapses the groups into one flat list: a search is asking "where
 * is X", and the answer should not be spread across five headings.
 *
 * The `shortlist` mode is the recommended group alone, under its own heading
 * and without the search field: the empty connection list shows it so a first
 * run is one click from a provider's form. It is a mode of this component
 * rather than a sibling because both need the same account-card query, and
 * the architecture ledger holds this file to one such call.
 */
export function ProviderCatalogPage(props: {
  connections: readonly LlmConnection[];
  onPick(target: SetupTarget): void;
} & (
  | { mode: 'catalog'; filter: CatalogFilter; onFilterChange(filter: CatalogFilter): void }
  | { mode: 'shortlist' }
)) {
  const locale = useUiLocale();
  const copy = getProviderSettingsCopy(locale).panel;
  const oauthCopy = getProviderSettingsCopy(locale).oauthSection;
  const query = props.mode === 'catalog' ? props.filter.query : '';
  const normalizedQuery = query.trim();
  const oauth = useOAuthCards({ query: normalizedQuery, connections: props.connections });
  const staleBanner = oauth.refreshError && (
    <Banner status="warning" role="alert" title={oauthCopy.staleState} description={oauth.refreshError} />
  );

  if (props.mode === 'shortlist') {
    return (
      <VStack gap={4}>
        {staleBanner}
        <ProviderCatalogRows
          title={copy.recommended}
          locale={locale}
          cards={oauth.cards}
          providers={providersMatching(RECOMMENDED_PROVIDER_TYPES, '', locale)}
          onPick={props.onPick}
        />
      </VStack>
    );
  }

  // Typing collapses the groups into one flat list without moving focus, so
  // the new count is spoken. The region is mounted on both branches: one added
  // at the same time as its text is not announced.
  const searchField = (matches: number | null) => (
    <>
      <TextInput
        value={query}
        onChange={(value) => props.onFilterChange({ query: value })}
        placeholder={copy.searchPlaceholder}
        label={copy.searchAria}
        isLabelHidden
        startIcon={Search}
        hasClear
      />
      <span className="maka-visually-hidden" role="status" aria-live="polite">
        {matches === null ? '' : getProviderSettingsCopy(locale).shared.filterMatches(matches)}
      </span>
    </>
  );

  if (normalizedQuery) {
    const providers = providersMatching(CATALOG_PROVIDER_TYPES, normalizedQuery, locale);
    const isEmpty = providers.length === 0 && oauth.cards.length === 0;
    return (
      <VStack gap={4} data-maka-contract="provider-catalog">
        {searchField(providers.length + oauth.cards.length)}
        {staleBanner}
        {isEmpty ? (
          // Filter empty (DESIGN.md §10 tier 1): a filter no-match always carries
          // the clear action, on any tier — the user must be able to exit.
          <EmptyState
            isCompact
            title={copy.noMatch}
            actions={(
              <Button
                variant="ghost"
                size="sm"
                label={copy.clearSearch}
                onClick={() => props.onFilterChange({ query: '' })}
              />
            )}
          />
        ) : (
          <ProviderCatalogRows locale={locale} cards={oauth.cards} providers={providers} onPick={props.onPick} />
        )}
      </VStack>
    );
  }

  return (
    <VStack gap={8} data-maka-contract="provider-catalog">
      {searchField(null)}
      {staleBanner}
      {CATALOG_GROUPS.map((group) => {
        const providers = group === 'recommended'
          ? providersMatching(RECOMMENDED_PROVIDER_TYPES, '', locale)
          : providersMatching(CATALOG_PROVIDER_TYPES, '', locale, group);
        const cards = group === 'recommended' ? oauth.cards : [];
        if (providers.length === 0 && cards.length === 0) return null;
        return (
          <ProviderCatalogRows
            key={group}
            title={copy.groups[group]}
            locale={locale}
            cards={cards}
            providers={providers}
            onPick={props.onPick}
          />
        );
      })}
    </VStack>
  );
}

/**
 * One list of provider rows: account sign-ins first, then keyed providers.
 * `title` is the group heading, rendered by the List itself so the list is
 * labelled by it.
 */
function ProviderCatalogRows(props: {
  title?: string;
  locale: UiLocale;
  cards: readonly OAuthCard[];
  providers: readonly ProviderType[];
  onPick(target: SetupTarget): void;
}) {
  const { locale } = props;
  const providerCopy = getProviderSettingsCopy(locale);
  return (
    <List hasDividers header={props.title && <Heading level={3}>{props.title}</Heading>}>
      {props.cards.map((card) => (
        <ListItem
          key={card.id}
          className="providerCatalogRow"
          data-card-id={card.id}
          data-provider={card.providerType}
          data-status="ready"
          data-logged-in={card.isLoggedIn ? 'true' : undefined}
          startContent={<ProviderLogo type={card.providerType} compact />}
          label={/* a11y-allow: this label names the ROW, not the span. Astryx's Item puts consumer props on its outer wrapper and renders a separate invisible <button> for the click target, so an aria-label on the Item never reaches that button — measured. The button is named from its content, and this span is how the status reaches that name. Removing it drops the runtime error from the row's accessible name (settings.spec:226).*/ <span aria-label={providerCopy.oauthSection.cardAria(
            'add',
            card.name,
            card.status,
            card.description,
          )}>{card.name}</span>}
          description={card.description}
          endContent={(
            <HStack gap={2} vAlign="center">
              {card.isLoggedIn && (
                <span className="settingsStatus" aria-hidden="true">
                  <Check size={ICON_SIZE.chrome} />
                  <span>{providerCopy.oauthSection.signedIn}</span>
                </span>
              )}
              <ChevronRight size={ICON_SIZE.chrome} aria-hidden="true" />
            </HStack>
          )}
          onClick={() => props.onPick({
            method: 'account',
            cardId: card.id,
            providerType: card.providerType,
            name: card.name,
          })}
        />
      ))}
      {props.providers.map((type) => {
        const display = providerDisplay(type, locale);
        return (
          <ListItem
            key={type}
            className="providerCatalogRow"
            data-provider={type}
            data-status="ready"
            startContent={<ProviderLogo type={type} compact />}
            label={/* a11y-allow: this label names the ROW, not the span. Astryx's Item puts consumer props on its outer wrapper and renders a separate invisible <button> for the click target, so an aria-label on the Item never reaches that button — measured. The button is named from its content, and this span is how the status reaches that name. Removing it drops the runtime error from the row's accessible name (settings.spec:226).*/ <span aria-label={providerCopy.catalog.cardAria(display.name, display.description)}>{display.name}</span>}
            description={display.description}
            endContent={<ChevronRight size={ICON_SIZE.chrome} aria-hidden="true" />}
            onClick={() => props.onPick({ method: 'credentials', providerType: type, name: display.name })}
          />
        );
      })}
    </List>
  );
}

/**
 * Level 3: one provider being set up — its credential form, or a new account
 * enrollment. Existing-account actions live on that Connection's detail page.
 */
export function ProviderSetupPage(props: {
  bridge: ConnectionsBridge;
  apiKeyOnboardingBridge?: ApiKeyOnboardingBridge;
  target: SetupTarget;
  existingSlugs: string[];
  onCancel(): void;
  onCreated(slug: string, modelDiscoveryError?: unknown): Promise<void>;
  onOnboarded?(identity: DesktopConnectionOnboardingIdentity): Promise<void>;
  onOnboardingOutcomeUnknown?(): Promise<void>;
  hasSaveUncertainty?: boolean;
  onAccountCreated(connection?: CreatedOAuthConnectionIdentity): Promise<void>;
  labelledBy?: string;
}) {
  if (props.target.method === 'account') {
    return (
      <div tabIndex={-1} role="region" aria-labelledby={props.labelledBy} className="settingsRouteLevel" data-maka-contract="provider-setup">
        <OAuthLoginPanel
          bridge={props.bridge}
          cardId={props.target.cardId}
          onLoginSuccess={props.onAccountCreated}
        />
      </div>
    );
  }
  return (
    <div tabIndex={-1} role="region" aria-labelledby={props.labelledBy} className="settingsRouteLevel" data-maka-contract="provider-setup">
      <AddProviderForm
        key={props.target.providerType}
        bridge={props.bridge}
        apiKeyOnboardingBridge={props.apiKeyOnboardingBridge}
        providerType={props.target.providerType}
        existingSlugs={props.existingSlugs}
        onCancel={props.onCancel}
        onCreated={props.onCreated}
        onOnboarded={props.onOnboarded}
        onOnboardingOutcomeUnknown={props.onOnboardingOutcomeUnknown}
        hasSaveUncertainty={props.hasSaveUncertainty}
      />
    </div>
  );
}

function providersMatching(
  source: readonly ProviderType[],
  query: string,
  locale: UiLocale,
  group?: ProviderCatalogGroup,
): ProviderType[] {
  const normalizedQuery = query.toLocaleLowerCase();
  return source.filter((type) => {
    if (!CATALOG_PROVIDER_TYPES.includes(type)) return false;
    if (PROVIDER_REGISTRY[type].status !== 'ready') return false;
    if (group && PROVIDER_REGISTRY[type].catalogGroup !== group) return false;
    if (!normalizedQuery) return true;
    const display = providerDisplay(type, locale);
    return [type, display.name, display.description, PROVIDER_REGISTRY[type].label]
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
  });
}
