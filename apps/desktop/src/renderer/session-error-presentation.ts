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

import type { ModelFailureKind } from '@maka/core/model-failure';
import type { UiLocale } from '@maka/core/ui-locale';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';

/**
 * Locale-aware allowlist for stable ErrorEvent.reason values emitted by the
 * runtime. Unknown reasons intentionally return undefined so callers can use
 * their existing safe fallback instead of displaying raw provider text.
 */
export function describeSessionErrorReason(reason: string | undefined, locale: UiLocale): string | undefined {
  const copy = getDesktopConversationCopy(locale).turnError;
  const kind = reason?.toLowerCase();
  if (kind === 'model_after_tool_timeout') return copy.timeout;
  const descriptions = {
    context_overflow: copy.contextOverflow,
    timeout: copy.timeout,
    auth: copy.auth,
    provider_billing: copy.providerBilling,
    provider_capacity: copy.providerCapacity,
    provider_unavailable: copy.provider,
    rate_limit: copy.rateLimit,
    network: copy.network,
    stream_truncated: copy.streamTruncated,
    request_rejected: copy.requestRejected,
    abort: copy.unknown,
    unknown: copy.unknown,
  } satisfies Record<ModelFailureKind, string>;
  return kind && Object.hasOwn(descriptions, kind) ? descriptions[kind as ModelFailureKind] : undefined;
}
