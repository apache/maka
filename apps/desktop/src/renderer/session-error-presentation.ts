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
import { getDesktopConversationCopy } from './locales/conversation-copy.js';

/**
 * Locale-aware allowlist for stable ErrorEvent.reason values emitted by the
 * runtime. Unknown reasons intentionally return undefined so callers can use
 * their existing safe fallback instead of displaying raw provider text.
 */
export function describeSessionErrorReason(reason: string | undefined, locale: UiLocale = 'zh'): string | undefined {
  const copy = getDesktopConversationCopy(locale).turnError;
  switch (reason?.toLowerCase()) {
    case 'context_overflow':
      return copy.contextOverflow;
    case 'timeout':
      return copy.timeout;
    case 'auth':
      return copy.auth;
    case 'provider_billing':
      return copy.providerBilling;
    case 'provider_unavailable':
      return copy.provider;
    case 'rate_limit':
      return copy.rateLimit;
    case 'network':
      return copy.network;
    default:
      return undefined;
  }
}
