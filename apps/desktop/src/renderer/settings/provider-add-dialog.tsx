import { useEffect, useRef, useState } from 'react';
import {
  Badge,
  Banner,
  Dialog,
  DialogHeader,
  EmptyState,
  HStack,
  IconButton,
  Layout,
  LayoutContent,
  List,
  ListItem,
  Selector,
  Text,
  Toolbar,
  VStack,
} from '@astryxdesign/core';
import { ArrowLeft, ChevronRight, Search } from '@maka/ui/icons';
import {
  CATALOG_PROVIDER_TYPES,
  PROVIDER_DEFAULTS,
  RECOMMENDED_PROVIDER_TYPES,
  type ProviderCatalogGroup,
  type ProviderType,
} from '@maka/core';
import { TextInput, useUiLocale } from '@maka/ui';
import { AddProviderForm } from './provider-add-form';
import { ProviderLogo, providerDisplay } from './provider-display';
import { OAuthLoginPanel, oauthPanelSubtitle, useOAuthCards, type OAuthCardId } from './provider-oauth-section';
import { type ConnectionsBridge } from './provider-panel-shared';
import { getProviderSettingsCopy } from '../locales/settings-provider-copy';

type CatalogCategory = ProviderCatalogGroup | 'recommended' | 'accounts';

const CATALOG_CATEGORIES: CatalogCategory[] = ['recommended', 'accounts', 'plans', 'api', 'aggregators', 'local'];

/** Which step the dialog is showing. */
type AddStep =
  | { kind: 'pick' }
  | { kind: 'form'; providerType: ProviderType }
  | { kind: 'oauth'; cardId: OAuthCardId; name: string; providerType: ProviderType };

/**
 * Add a model connection: pick a provider, then configure it — both inside one
 * Dialog.
 *
 * The two steps are not two Dialogs. Astryx's Dialog guidance says so
 * directly: "Nest dialogs inside other dialogs; restructure the flow into
 * steps within a single dialog instead." Stepping in place also keeps the
 * search query and category alive behind the form, so backing out of a
 * provider returns the user to the list exactly where they left it.
 */
export function AddConnectionDialog(props: {
  bridge: ConnectionsBridge;
  existingSlugs: string[];
  isOpen: boolean;
  onOpenChange(isOpen: boolean): void;
  /** Land straight on one provider's form — the first-run hero's path. */
  initialProviderType?: ProviderType;
  onConnectionsChanged(): Promise<void>;
  onCreated(providerType: ProviderType, modelDiscoveryError?: unknown): Promise<void>;
}) {
  const locale = useUiLocale();
  const providerCopy = getProviderSettingsCopy(locale);
  const copy = providerCopy.panel;
  const catalogCopy = providerCopy.catalog;
  const [step, setStep] = useState<AddStep>(() =>
    props.initialProviderType ? { kind: 'form', providerType: props.initialProviderType } : { kind: 'pick' });
  const [category, setCategory] = useState<CatalogCategory>('recommended');
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const oauth = useOAuthCards({
    query: category === 'recommended' || category === 'accounts' ? query : undefined,
    onConnectionsChanged: props.onConnectionsChanged,
  });

  // Category is a Selector, not a second TabList: the dialog header already
  // owns one level of navigation, and six tabs plus a search field made the
  // toolbar the busiest row on the page.
  const categoryOptions = CATALOG_CATEGORIES.map((value) => ({ value, label: copy.tabs[value] }));
  const showsOAuth = category === 'recommended' || category === 'accounts';
  const providers = providersForCategory(category, query, locale);
  const isEmpty = providers.length === 0 && (!showsOAuth || oauth.cards.length === 0);

  function backToPick() {
    setStep({ kind: 'pick' });
    focusSearch();
  }

  function focusSearch() {
    // Search is the dialog's first real control, so it takes focus on open and
    // again on the way back from a provider — otherwise the focus ring lands
    // on the dialog container and reads as a box drawn around the title.
    window.requestAnimationFrame(() => searchRef.current?.focus());
  }

  useEffect(() => {
    if (props.isOpen && step.kind === 'pick') focusSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- step.kind only.
  }, [props.isOpen, step.kind]);

  const isPicking = step.kind === 'pick';
  const headerTitle = step.kind === 'form'
    ? copy.connectTitle(providerDisplay(step.providerType, locale).name)
    : step.kind === 'oauth'
      ? copy.connectTitle(step.name)
      : copy.addConnection;
  const headerSubtitle = step.kind === 'form'
    ? copy.createSubtitle
    : step.kind === 'oauth'
      ? oauthPanelSubtitle(step.cardId, providerCopy.oauthSection)
      : copy.addHelp;

  return (
    <Dialog
      isOpen={props.isOpen}
      onOpenChange={props.onOpenChange}
      className="providerConnectionDialog"
      width={560}
      maxHeight="calc(100dvh - 80px)"
      purpose="form"
      padding={6}
    >
      <Layout
        header={(
          <DialogHeader
            startContent={isPicking ? undefined : (
              <HStack gap={2} vAlign="center">
                {/* The back affordance sits in the header's start slot rather
                    than in the body, so the step the user is on and the way
                    out of it read as one unit. */}
                <IconButton
                  variant="ghost"
                  label={copy.back}
                  tooltip={copy.back}
                  icon={<ArrowLeft size={16} aria-hidden="true" />}
                  onClick={backToPick}
                  data-maka-contract="add-connection-back"
                />
                <ProviderLogo
                  type={step.kind === 'form' ? step.providerType : step.providerType}
                  compact
                />
              </HStack>
            )}
            title={headerTitle}
            subtitle={headerSubtitle}
            onOpenChange={props.onOpenChange}
          />
        )}
        content={(
          <LayoutContent padding={6} isScrollable>
            {step.kind === 'form' ? (
              <AddProviderForm
                key={step.providerType}
                bridge={props.bridge}
                providerType={step.providerType}
                existingSlugs={props.existingSlugs}
                onCancel={props.initialProviderType ? () => props.onOpenChange(false) : backToPick}
                onCreated={async (_slug, modelDiscoveryError) => {
                  await props.onCreated(step.providerType, modelDiscoveryError);
                }}
              />
            ) : step.kind === 'oauth' ? (
              <OAuthLoginPanel cardId={step.cardId} onLoginSuccess={oauth.refreshAfterOAuthChange} />
            ) : (
              <VStack gap={4} data-maka-contract="provider-catalog">
                <Toolbar
                  label={copy.categoriesAria}
                  gap={2}
                  startContent={(
                    <TextInput
                      ref={searchRef}
                      value={query}
                      onChange={setQuery}
                      placeholder={copy.searchPlaceholder}
                      label={copy.searchAria}
                      isLabelHidden
                      startIcon={<Search aria-hidden="true" />}
                      width="100%"
                    />
                  )}
                  endContent={(
                    <Selector
                      label={copy.category}
                      isLabelHidden
                      value={category}
                      onChange={(value: string) => setCategory(value as CatalogCategory)}
                      options={categoryOptions}
                      data-catalog-category={category}
                    />
                  )}
                />
                {oauth.refreshError && (
                  <Banner
                    status="warning"
                    role="alert"
                    title={providerCopy.oauthSection.staleState}
                    description={oauth.refreshError}
                  />
                )}
                {isEmpty ? (
                  <EmptyState isCompact title={copy.noMatch} />
                ) : (
                  <List hasDividers>
                    {showsOAuth && oauth.cards.map((card) => (
                      <ListItem
                        key={card.id}
                        className="providerCatalogRow"
                        data-card-id={card.id}
                        data-provider={card.providerType}
                        data-status="ready"
                        data-logged-in={card.isLoggedIn ? 'true' : undefined}
                        startContent={<ProviderLogo type={card.providerType} />}
                        label={<span aria-label={providerCopy.oauthSection.cardAria(card.name, card.badge, card.description)}>{card.name}</span>}
                        description={card.description}
                        endContent={(
                          <HStack gap={2} vAlign="center">
                            <Badge variant={card.isLoggedIn ? 'neutral' : 'info'} label={card.badge} />
                            <ChevronRight size={15} aria-hidden="true" />
                          </HStack>
                        )}
                        onClick={() => setStep({
                          kind: 'oauth',
                          cardId: card.id,
                          name: card.name,
                          providerType: card.providerType,
                        })}
                      />
                    ))}
                    {providers.map((type) => {
                      const display = providerDisplay(type, locale);
                      return (
                        <ListItem
                          key={type}
                          className="providerCatalogRow"
                          data-provider={type}
                          data-status="ready"
                          startContent={<ProviderLogo type={type} />}
                          label={<span aria-label={catalogCopy.cardAria(display.name, display.badge, display.description, 0)}>{display.name}</span>}
                          description={display.description}
                          endContent={(
                            <HStack gap={2} vAlign="center">
                              {display.badge && <Badge variant="neutral" label={display.badge} />}
                              <ChevronRight size={15} aria-hidden="true" />
                            </HStack>
                          )}
                          onClick={() => setStep({ kind: 'form', providerType: type })}
                        />
                      );
                    })}
                  </List>
                )}
              </VStack>
            )}
          </LayoutContent>
        )}
      />
    </Dialog>
  );
}

function providersForCategory(category: CatalogCategory, query: string, locale: 'zh' | 'en'): ProviderType[] {
  // 'accounts' is the OAuth-only category: every row in it comes from
  // useOAuthCards, so the keyed catalog contributes nothing.
  if (category === 'accounts') return [];
  const source = category === 'recommended' ? RECOMMENDED_PROVIDER_TYPES : CATALOG_PROVIDER_TYPES;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return source.filter((type) => {
    if (!CATALOG_PROVIDER_TYPES.includes(type)) return false;
    if (PROVIDER_DEFAULTS[type].status !== 'ready') return false;
    if (category !== 'recommended' && PROVIDER_DEFAULTS[type].catalogGroup !== category) return false;
    if (!normalizedQuery) return true;
    const display = providerDisplay(type, locale);
    return [type, display.name, display.description, PROVIDER_DEFAULTS[type].label]
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
  });
}
