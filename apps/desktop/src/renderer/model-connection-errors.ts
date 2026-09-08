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

import type { ChatConfigurationReason } from '@maka/core/connection-readiness';
import type { SessionEvent } from '@maka/core/events';
import type { UiLocale } from '@maka/core/ui-locale';
import {
  NO_REAL_CONNECTION_CODE,
  parseNoRealConnectionError,
} from './application/contracts/connection-error-cleaner.js';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';
import { localizedShellErrorMessage } from './locales/shell-copy.js';
import { describeSessionErrorReason } from './session-error-presentation.js';

export function isNoRealConnectionError(error: unknown): boolean {
  return parseNoRealConnectionError(error).matched;
}

export function isNoRealConnectionEvent(event: Extract<SessionEvent, { type: 'error' }>): boolean {
  return event.code === NO_REAL_CONNECTION_CODE || parseNoRealConnectionError(event.message).matched;
}

export function noRealConnectionReasonFromError(error: unknown): string | undefined {
  return parseNoRealConnectionError(error).reason;
}

export function noRealConnectionReasonFromEvent(event: Extract<SessionEvent, { type: 'error' }>): string | undefined {
  return parseNoRealConnectionError(
    event.reason ? `${NO_REAL_CONNECTION_CODE}:${event.reason}` : event.message,
  ).reason;
}

export function noRealConnectionSetupDescription(reason: string | undefined, locale: UiLocale): string {
  const copy = getDesktopConversationCopy(locale).model;
  return reason && Object.hasOwn(copy.configurationReason, reason)
    ? copy.configurationReason[reason as ChatConfigurationReason]
    : copy.configurationFallback;
}

export function sessionEventErrorMessage(
  event: Extract<SessionEvent, { type: 'error' }>,
  locale: UiLocale,
): string {
  if (isNoRealConnectionEvent(event)) {
    return noRealConnectionSetupDescription(noRealConnectionReasonFromEvent(event), locale);
  }
  const reasonDescription = describeSessionErrorReason(event.reason, locale);
  if (reasonDescription) return reasonDescription;
  const fallback = getDesktopConversationCopy(locale).actions.conversationErrorFallback;
  return localizedShellErrorMessage(new Error(event.message), fallback, locale);
}

export function modelSetupToastCopy(
  reason: string | undefined,
  fallback: string,
  locale: UiLocale,
): { title: string; description: string } {
  const copy = getDesktopConversationCopy(locale).model;
  if (reason === 'connection_missing') {
    return {
      title: copy.connectionMissingTitle,
      description: noRealConnectionSetupDescription(reason, locale),
    };
  }
  return {
    title: copy.setupTitle,
    description: fallback,
  };
}
