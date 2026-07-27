import { ChevronRight } from '@maka/ui/icons';
import { PROVIDER_DEFAULTS, isWiredOAuthProvider, type ProviderType } from '@maka/core';
import { Chip, Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle, useUiLocale } from '@maka/ui';
import { ProviderLogo, providerDisplay } from './provider-display';
import { getProviderSettingsCopy } from '../locales/settings-provider-copy';

export function ProviderCatalogCard(props: { type: ProviderType; count: number; onSelect(): void }) {
  const locale = useUiLocale();
  const copy = getProviderSettingsCopy(locale).catalog;
  const defaults = PROVIDER_DEFAULTS[props.type];
  const display = providerDisplay(props.type, locale);
  const disabled = defaults.status !== 'ready';
  const disabledStatus = providerDisabledStatus(props.type);
  const title = disabled
    ? (isWiredOAuthProvider(props.type) ? copy.wiredHelp : copy.unwiredHelp)
    : copy.addTitle(display.name);

  if (disabled) {
    return (
      <Item
        className="providerCatalogRow"
        data-provider={props.type}
        data-status={disabledStatus}
        data-disabled="true"
        aria-label={isWiredOAuthProvider(props.type) ? copy.wiredTitle(display.name) : copy.unwiredTitle(display.name)}
        title={title}
      >
        <ItemMedia>
          <ProviderLogo type={props.type} />
        </ItemMedia>
        <ItemContent>
          <ItemTitle className="providerCatalogTitle">{display.name}</ItemTitle>
          <ItemDescription className="providerCatalogDesc">{display.description}</ItemDescription>
        </ItemContent>
        <ItemActions>
          {/* Gated-provider state label — experimental (warning) / unavailable
              (info). Migrated onto the squared Chip primitive (tone→alpha
              authority); the row itself stays inert. */}
          <Chip
            size="sm"
            variant={disabledStatus === 'experimental' ? 'warning' : 'info'}
            className="providerCatalogStateBadge"
            aria-hidden="true"
          >
            {disabledStatus === 'experimental' ? copy.experiment : copy.unavailable}
          </Chip>
        </ItemActions>
      </Item>
    );
  }

  return (
    <Item
      className="providerCatalogRow"
      data-provider={props.type}
      data-status="ready"
      aria-label={copy.cardAria(display.name, display.badge, display.description, props.count)}
      title={title}
      render={<button type="button" onClick={props.onSelect} />}
    >
      <ItemMedia>
        <ProviderLogo type={props.type} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="providerCatalogTitle">{display.name}</ItemTitle>
        <ItemDescription className="providerCatalogDesc">
          {display.description}
          {props.count > 0 && <span className="providerCatalogCount">{copy.configured(props.count)}</span>}
        </ItemDescription>
      </ItemContent>
      <ItemActions className="providerCatalogActions">
        {display.badge && <span className="providerCatalogBadge">{display.badge}</span>}
        <ChevronRight className="providerCatalogChevron" size={15} aria-hidden="true" />
      </ItemActions>
    </Item>
  );
}

function providerDisabledStatus(type: ProviderType): 'unavailable' | 'experimental' {
  return isWiredOAuthProvider(type) ? 'experimental' : 'unavailable';
}
