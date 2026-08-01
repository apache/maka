import type { ReactNode } from 'react';
import { ChevronRight, MessageSquare } from '@maka/ui/icons';
import type { BotChannelSettings, BotProvider } from '@maka/core';
import type { BotStatus } from '@maka/runtime';
import { BOT_PROVIDERS } from '@maka/core/settings';
import { EmptyState, Item } from '@astryxdesign/core';
import { Button, Badge, RelativeTime, useUiLocale, Banner } from '@maka/ui';
import { deriveBotChannelViewState } from './bot-settings-view-model';
import { BOT_LABELS, BotBrandLogo, botReadinessCopyForSupport, botStatusDetail } from './bot-chat-shared';
import { getBotSettingsCopy } from '../locales/settings-bot-copy';
import { statusBadgeVariant } from './settings-status-badge';

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

  return (
    <div className="settingsRemoteAccessOverview">
      {props.statusLoadError && (
        <Banner
          status="error"
          title={copy.loadFailed}
          description={props.statusLoadError}
          endContent={<Button variant="secondary" onClick={() => void props.onRefreshStatuses()} label={copy.reload} />} />
      )}
      <section className="settingsRemoteAccessSection" aria-labelledby="remote-access-active-heading">
        <div className="settingsRemoteAccessSectionHeader">
          <h3 id="remote-access-active-heading">{copy.active}</h3>
          <span>{copy.sortHint}</span>
        </div>
        <div className="settingsRemoteAccessActiveList">
          {activeChannels.length === 0 ? (
            <EmptyState
              icon={<MessageSquare />}
              title={copy.empty}
              description={copy.emptyHelp}
              className="settingsRemoteAccessEmpty"
            />
          ) : activeChannels.map((entry) => (
            <Item
              key={entry.provider}
              className="settingsRemoteAccessChannelRow"
              data-attention={entry.needsAttention ? 'true' : undefined}
              startContent={<BotBrandLogo provider={entry.provider} />}
              label={(
                <span className="settingsRemoteAccessItemTitle" aria-label={copy.manageAria(botCopy.providers[entry.provider].label, entry.copy.label)}>
                  {botCopy.providers[entry.provider].label}
                  <Badge variant={statusBadgeVariant(entry.copy.tone)} label={entry.copy.label} />
                </span>
              )}
              description={(
                <span className="settingsRemoteAccessItemDescription" id={`settings-remote-access-${entry.provider}-summary`}>
                  {botOverviewDetail(entry.status, entry.currentError, entry.copy.detail, entry.liveOperational, locale)}
                </span>
              )}
              endContent={<span className="settingsRemoteAccessItemActions"><ChevronRight size={16} aria-hidden="true" /></span>}
              onClick={() => props.onOpenChannel(entry.provider)}
            />
          ))}
        </div>
      </section>
      <section className="settingsRemoteAccessSection" aria-labelledby="remote-access-available-heading">
        <div className="settingsRemoteAccessSectionHeader">
          <h3 id="remote-access-available-heading">{copy.more}</h3>
          <span>{copy.choose}</span>
        </div>
        <div className="settingsRemoteAccessCatalog">
          {availableChannels.map((entry) => (
            <Item
              key={entry.provider}
              className="settingsRemoteAccessCatalogRow"
              data-support={entry.support}
              startContent={<BotBrandLogo provider={entry.provider} />}
              label={<span className="settingsRemoteAccessItemTitle" aria-label={copy.connectAria(botCopy.providers[entry.provider].label)}>{botCopy.providers[entry.provider].label}</span>}
              description={botCopy.providers[entry.provider].help}
              endContent={<span className="settingsRemoteAccessItemActions"><ChevronRight size={16} aria-hidden="true" /></span>}
              onClick={() => props.onOpenChannel(entry.provider)}
            />
          ))}
        </div>
      </section>
    </div>
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
