import type { ReactNode } from 'react';
import { ChevronRight, MessageSquare } from '@maka/ui/icons';
import type { BotChannelSettings, BotProvider } from '@maka/core';
import type { BotStatus } from '@maka/runtime';
import { BOT_PROVIDERS } from '@maka/core/settings';
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
  Button,
  Chip,
  EmptyState,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
  RelativeTime,
  useUiLocale,
} from '@maka/ui';
import { deriveBotChannelViewState } from './bot-settings-view-model';
import { BOT_LABELS, BotBrandLogo, botReadinessCopyForSupport, botStatusDetail } from './bot-chat-shared';
import { getBotSettingsCopy } from '../locales/settings-bot-copy';

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
        <Alert variant="error">
          <AlertTitle>{copy.loadFailed}</AlertTitle>
          <AlertDescription>{props.statusLoadError}</AlertDescription>
          <AlertAction>
            <Button variant="secondary" onClick={() => void props.onRefreshStatuses()} label={copy.reload} />
          </AlertAction>
        </Alert>
      )}

      <section className="settingsRemoteAccessSection" aria-labelledby="remote-access-active-heading">
        <div className="settingsRemoteAccessSectionHeader">
          <h3 id="remote-access-active-heading">{copy.active}</h3>
          <span>{copy.sortHint}</span>
        </div>
        <div className="settingsRemoteAccessActiveList">
          {activeChannels.length === 0 ? (
            <EmptyState
              Icon={MessageSquare}
              title={copy.empty}
              body={copy.emptyHelp}
              extraClassName="settingsRemoteAccessEmpty"
            />
          ) : activeChannels.map((entry) => (
            <Item
              key={entry.provider}
              className="settingsRemoteAccessChannelRow"
              data-attention={entry.needsAttention ? 'true' : undefined}
              render={(
                <button
                  type="button"
                  aria-label={copy.manageAria(botCopy.providers[entry.provider].label, entry.copy.label)}
                  aria-describedby={`settings-remote-access-${entry.provider}-summary`}
                  onClick={() => props.onOpenChannel(entry.provider)}
                />
              )}
            >
              <ItemMedia><BotBrandLogo provider={entry.provider} /></ItemMedia>
              <ItemContent>
                <ItemTitle>
                  {botCopy.providers[entry.provider].label}
                  <Chip dot size="sm" variant={entry.copy.tone}>{entry.copy.label}</Chip>
                </ItemTitle>
                <ItemDescription id={`settings-remote-access-${entry.provider}-summary`}>
                  {botOverviewDetail(entry.status, entry.currentError, entry.copy.detail, entry.liveOperational, locale)}
                </ItemDescription>
              </ItemContent>
              <ItemActions><ChevronRight size={16} aria-hidden="true" /></ItemActions>
            </Item>
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
              render={(
                <button
                  type="button"
                  aria-label={copy.connectAria(botCopy.providers[entry.provider].label)}
                  onClick={() => props.onOpenChannel(entry.provider)}
                />
              )}
            >
              <ItemMedia><BotBrandLogo provider={entry.provider} /></ItemMedia>
              <ItemContent>
                <ItemTitle>{botCopy.providers[entry.provider].label}</ItemTitle>
                <ItemDescription>{botCopy.providers[entry.provider].help}</ItemDescription>
              </ItemContent>
              <ItemActions><ChevronRight size={16} aria-hidden="true" /></ItemActions>
            </Item>
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
