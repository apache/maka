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

import type { UiLocale } from '@maka/core/ui-locale';
import type { DesktopLocalMessage } from '../../../../shared/session-local-contract.js';
import { getSessionLocalCopy } from '../../../locales/session-local-copy.js';

export function localMessagePresentation(
  message: DesktopLocalMessage, locale: UiLocale,
): { status?: string; detail?: string; tone: 'neutral' | 'warning' | 'danger' } {
  const copy = getSessionLocalCopy(locale);
  // Ordinary delivery keeps the prompt and answer geometry stable. Only a
  // condition the user can act on needs a separate local-delivery status.
  if (message.state === 'accepted' || message.state === 'sending'
    || (message.state === 'saved' && message.delivering && !message.error)) return { tone: 'neutral' };
  if (message.state === 'failed') return { status: copy.failed, detail: copy.failedDetail, tone: 'danger' };
  if (message.state === 'unknown') return {
    status: message.checking ? copy.checking : copy.unknown,
    detail: `${copy.unknownDetail}${message.retryScheduled && !message.waitingForConnection ? ` ${copy.retryDetail}` : ''}`,
    tone: 'warning',
  };
  return {
    status: message.waitingForConnection ? copy.offline : copy.saved, detail: copy.savedDetail, tone: 'neutral',
  };
}
