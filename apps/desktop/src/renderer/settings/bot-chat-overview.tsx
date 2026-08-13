import type { ReactNode } from 'react';
import { ICON_SIZE, ChevronRight } from '@maka/ui/icons';
import type { BotChannelSettings, BotProvider } from '@maka/core/bot-chat-settings';
import type { BotStatus } from '@maka/runtime/bots';
import { BOT_PROVIDERS } from '@maka/core/settings';
import { EmptyState, Item, StatusDot } from '@astryxdesign/core';
import { Button, RelativeTime, useUiLocale, Banner } from '@maka/ui';
import { deriveBotChannelViewState } from './bot-settings-view-model';
import { BOT_LABELS, BotBrandLogo, botReadinessCopyForSupport, botStatusDetail } from './bot-chat-shared';
import { getBotSettingsCopy } from '../locales/settings-bot-copy';
import { SettingsPage, SettingsSection } from './settings-section';
import { dotForStatus } from '@maka/ui';

/**
 * Remote-access overview: the "正在使用" list of configured channels plus
 * the catalog of platforms that can still be connected. Pure presentation —
 * the page owns status fetching and routing, this component derives the
 * per-channel view rows during render.
 */
export function BotChatOverview(props: {
  channels: Record<BotProvider, BotChannelSettings>;
  statuses: Record<BotProvider, BotStatus> | null;
  statusLoadError: string | null;
  onOpenChannel(provider: BotProvider): void;
  onRefreshStatuses(): Promise<boolean>;
}) {
  const locale = useUiLocale();
  const botCopy = getBotSettingsCopy(locale);
  const copy = botCopy.overview;
  const overviewChannels = BOT_PROVIDERS.map((provider, index) => {
    const providerChannel = props.channels[provider];
    const providerStatus = props.statuses?.[provider];
    const providerSupport = BOT_LABELS[provider].support;
    const providerViewState = deriveBotChannelViewState({
      channel: providerChannel,
      status: providerStatus,
    });
    const providerCopy = botReadinessCopyForSupport(providerSupport, providerViewState.readiness, locale);
    return {
      provider,
      index,
      status: providerStatus,
      support: providerSupport,
      copy: providerCopy,
      configured: providerViewState.configured,
      needsAttention: providerViewState.needsAttention,
      currentError: providerViewState.currentError,
      liveOperational: providerViewState.liveOperational,
    };
  });
  const activeChannels = overviewChannels
    .filter((entry) => entry.configured)
    .sort((left, right) => {
      if (left.needsAttention !== right.needsAttention) return left.needsAttention ? -1 : 1;
      const activityDelta = (right.status?.lastEventAt ?? 0) - (left.status?.lastEventAt ?? 0);
      return activityDelta || left.index - right.index;
    });
  const availableChannels = overviewChannels.filter((entry) => !entry.configured);

  // Astryx convergence: the overview was the last page speaking the
  // pre-#1972 dialect — bespoke page container, section-header dialect,
  // hand-rolled list grids, a decorative readiness Badge. It is a kit page
  // now: SettingsPage → SettingsSection (whose headings keep the ids the
  // remote-access e2e names sections by) → hairline rows; readiness reads
  // as the shared StatusDot + text idiom.
  return (
    <SettingsPage>
      {props.statusLoadError && (
        <Banner
          status="error"
          title={copy.loadFailed}
          description={props.statusLoadError}
          endContent={<Button variant="secondary" onClick={() => void props.onRefreshStatuses()} label={copy.reload} />} />
      )}
      <SettingsSection titleId="remote-access-active-heading" title={copy.active} description={copy.sortHint}>
          {activeChannels.length === 0 ? (
            // Section-local absence (DESIGN.md §10 tier 1): no icon, no
            // description — the catalog below is the way forward.
            (<EmptyState isCompact title={copy.empty} />)
          ) : activeChannels.map((entry) => (
            <Item
              key={entry.provider}
              className="settingsRemoteAccessChannelRow"
              data-attention={entry.needsAttention ? 'true' : undefined}
              startContent={<BotBrandLogo provider={entry.provider} />}
              label={(
                // a11y-allow: this label names the ROW, not the span. Astryx's Item puts consumer props on its outer wrapper and renders a separate invisible <button> for the click target, so an aria-label on the Item never reaches that button — measured. The button is named from its content, and this span is how the status reaches that name. Removing it drops the runtime error from the row's accessible name (settings.spec:226).
                (<span className="settingsRemoteAccessItemTitle" aria-label={copy.manageAria(botCopy.providers[entry.provider].label, entry.copy.label)}>
                  {botCopy.providers[entry.provider].label}
                  <span className="settingsStatus">
                    <StatusDot variant={dotForStatus(entry.copy.tone)} label={entry.copy.label} />
                    <span>{entry.copy.label}</span>
                  </span>
                </span>)
              )}
              description={(
                <span className="settingsRemoteAccessItemDescription" id={`settings-remote-access-${entry.provider}-summary`}>
                  {botOverviewDetail(entry.status, entry.currentError, entry.copy.detail, entry.liveOperational, locale)}
                </span>
              )}
              endContent={<span className="settingsRemoteAccessItemActions"><ChevronRight size={ICON_SIZE.chrome} aria-hidden="true" /></span>}
              onClick={() => props.onOpenChannel(entry.provider)}
            />
          ))}
      </SettingsSection>
      <SettingsSection titleId="remote-access-available-heading" title={copy.more} description={copy.choose}>
          {availableChannels.map((entry) => (
            <Item
              key={entry.provider}
              className="settingsRemoteAccessCatalogRow"
              data-support={entry.support}
              startContent={<BotBrandLogo provider={entry.provider} />}
              label={/* a11y-allow: this label names the ROW, not the span. Astryx's Item puts consumer props on its outer wrapper and renders a separate invisible <button> for the click target, so an aria-label on the Item never reaches that button — measured. The button is named from its content, and this span is how the status reaches that name. Removing it drops the runtime error from the row's accessible name (settings.spec:226).*/ <span className="settingsRemoteAccessItemTitle" aria-label={copy.connectAria(botCopy.providers[entry.provider].label)}>{botCopy.providers[entry.provider].label}</span>}
              description={botCopy.providers[entry.provider].help}
              endContent={<span className="settingsRemoteAccessItemActions"><ChevronRight size={ICON_SIZE.chrome} aria-hidden="true" /></span>}
              onClick={() => props.onOpenChannel(entry.provider)}
            />
          ))}
      </SettingsSection>
    </SettingsPage>
  );
}

function botOverviewDetail(
  status: BotStatus | undefined,
  currentError: string | undefined,
  fallback: string,
  liveOperational: boolean,
  locale: 'zh' | 'en',
): ReactNode {
  const copy = getBotSettingsCopy(locale).overview;
  const identity = status?.identity?.username ?? status?.identity?.displayName;
  if (liveOperational) {
    return (
      <>
        {copy.listening}{identity ? ` · ${identity}` : ''}
        {status?.lastEventAt ? <> · <RelativeTime ts={status.lastEventAt} /></> : ''}
      </>
    );
  }
  if (currentError) return locale === 'zh' ? currentError : fallback;
  if (status?.reason) return botStatusDetail(status, locale);
  return fallback;
}
