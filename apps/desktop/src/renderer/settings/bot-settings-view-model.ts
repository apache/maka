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
