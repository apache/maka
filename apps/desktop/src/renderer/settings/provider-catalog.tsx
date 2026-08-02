import { PROVIDER_DEFAULTS, isWiredOAuthProvider, type ProviderType } from '@maka/core';
import { Badge, HStack, ListItem, Text } from '@astryxdesign/core';
import { ChevronRight } from '@maka/ui/icons';
import { useUiLocale } from '@maka/ui';
import { ProviderLogo, providerDisplay } from './provider-display';
import { getProviderSettingsCopy } from '../locales/settings-provider-copy';

/**
 * One catalog row. Geometry — row padding, the gap between media, copy and
 * actions, label and description type — belongs to Astryx `Item`; this file
 * only decides what goes in each slot. The `providerCatalogRow` class and the
 * `data-provider` / `data-status` attributes stay as test and brand hooks
 * (`providers.spec.ts` locates rows through them); neither carries geometry.
 */
export function ProviderCatalogCard(props: { type: ProviderType; count: number; onSelect(): void }) {
  const locale = useUiLocale();
  const copy = getProviderSettingsCopy(locale).catalog;
  const defaults = PROVIDER_DEFAULTS[props.type];
  const display = providerDisplay(props.type, locale);
  const disabled = defaults.status !== 'ready';
  const disabledStatus = providerDisabledStatus(props.type);
  if (disabled) {
    return (
      <ListItem
        className="providerCatalogRow"
        data-provider={props.type}
        data-status={disabledStatus}
        data-disabled="true"
        isDisabled
        aria-label={isWiredOAuthProvider(props.type) ? copy.wiredTitle(display.name) : copy.unwiredTitle(display.name)}
        startContent={<ProviderLogo type={props.type} />}
        label={display.name}
        description={display.description}
        endContent={(
          <Badge
            variant={disabledStatus === 'experimental' ? 'warning' : 'info'}
            aria-hidden="true"
            label={disabledStatus === 'experimental' ? copy.experiment : copy.unavailable}
          />
        )}
      />
    );
  }

  return (
    <ListItem
      className="providerCatalogRow"
      data-provider={props.type}
      data-status="ready"
      startContent={<ProviderLogo type={props.type} />}
      label={<span aria-label={copy.cardAria(display.name, display.badge, display.description, props.count)}>{display.name}</span>}
      description={(
        <>
          {display.description}
          {props.count > 0 && (
            <Text as="span" size="sm" color="secondary">{` · ${copy.configured(props.count)}`}</Text>
          )}
        </>
      )}
      endContent={(
        <HStack gap={2} align="center">
          {display.badge && <Badge variant="neutral" label={display.badge} />}
          <ChevronRight size={15} aria-hidden="true" />
        </HStack>
      )}
      onClick={props.onSelect}
    />
  );
}

function providerDisabledStatus(type: ProviderType): 'unavailable' | 'experimental' {
  return isWiredOAuthProvider(type) ? 'experimental' : 'unavailable';
}
