import { ChevronRight } from '@maka/ui/icons';
import { PROVIDER_DEFAULTS, isWiredOAuthProvider, type ProviderType } from '@maka/core';
import { Item } from '@astryxdesign/core';
import { Badge, useUiLocale } from '@maka/ui';
import { ProviderLogo, providerDisplay } from './provider-display';
import { getProviderSettingsCopy } from '../locales/settings-provider-copy';

export function ProviderCatalogCard(props: { type: ProviderType; count: number; onSelect(): void }) {
  const locale = useUiLocale();
  const copy = getProviderSettingsCopy(locale).catalog;
  const defaults = PROVIDER_DEFAULTS[props.type];
  const display = providerDisplay(props.type, locale);
  const disabled = defaults.status !== 'ready';
  const disabledStatus = providerDisabledStatus(props.type);
  if (disabled) {
    return (
      <Item
        className="providerCatalogRow"
        data-provider={props.type}
        data-status={disabledStatus}
        data-disabled="true"
        isDisabled
        aria-label={isWiredOAuthProvider(props.type) ? copy.wiredTitle(display.name) : copy.unwiredTitle(display.name)}
        startContent={<ProviderLogo type={props.type} />}
        label={<span className="providerCatalogTitle">{display.name}</span>}
        description={<span className="providerCatalogDesc">{display.description}</span>}
        endContent={(
          /* Tinted archive, not the semantic one — this is a catalogue
             decoration, not a status seam, and the rule it replaced was a
             tint. `statusBadgeVariant`'s solid archive is reserved for the
             rows that actually report state. */
          <Badge
            variant={disabledStatus === 'experimental' ? 'yellow' : 'blue'}
            aria-hidden="true"
            label={disabledStatus === 'experimental' ? copy.experiment : copy.unavailable}
          />
        )}
      />
    );
  }

  return (
    <Item
      className="providerCatalogRow"
      data-provider={props.type}
      data-status="ready"
      startContent={<ProviderLogo type={props.type} />}
      label={<span className="providerCatalogTitle" aria-label={copy.cardAria(display.name, display.badge, display.description, props.count)}>{display.name}</span>}
      description={(
        <span className="providerCatalogDesc">
          {display.description}
          {props.count > 0 && <span className="providerCatalogCount">{copy.configured(props.count)}</span>}
        </span>
      )}
      endContent={<span className="providerCatalogActions">
        {display.badge && <Badge label={display.badge} />}
        <ChevronRight className="providerCatalogChevron" size={15} aria-hidden="true" />
      </span>}
      onClick={props.onSelect}
    />
  );
}

function providerDisabledStatus(type: ProviderType): 'unavailable' | 'experimental' {
  return isWiredOAuthProvider(type) ? 'experimental' : 'unavailable';
}
