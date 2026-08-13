import { humanizeBotStatusReason } from '@maka/core/bot-events';
import { type BotChannelSettings, type BotReadinessState } from '@maka/core/bot-chat-settings';
import type { BotStatus } from '@maka/runtime/bots';

export function deriveBotChannelViewState(input: {
  channel: BotChannelSettings;
  status: BotStatus | undefined;
}): {
  readiness: BotReadinessState;
  configured: boolean;
  needsAttention: boolean;
  currentError: string | undefined;
  liveOperational: boolean;
} {
  const { channel, status } = input;
  const readiness = channel.enabled || status?.running
    ? status?.readiness ?? channel.readiness
    : channel.readiness;
  const configured = channel.connected
    || channel.enabled
    || status?.running === true
    || Boolean(status?.identity)
    || isConfiguredReadiness(channel.readiness)
    || isConfiguredReadiness(readiness);
  const liveOperational = status?.running === true && readiness === 'operational';
  const liveError = readiness === 'degraded'
    ? humanizeBotStatusReason(status?.reason)
    : undefined;
  const currentError = liveOperational ? undefined : liveError ?? channel.lastError;
  const needsAttention = configured && (
    readiness === 'degraded'
    || Boolean(currentError)
    || (channel.enabled && status?.running === false)
  );

  return { readiness, configured, needsAttention, currentError, liveOperational };
}

function isConfiguredReadiness(readiness: BotReadinessState): boolean {
  return readiness === 'configured'
    || readiness === 'credentials_valid'
    || readiness === 'operational'
    || readiness === 'degraded';
}
