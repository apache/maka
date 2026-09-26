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

import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';
import type { SessionAttention } from '@maka/runtime-host/protocol';

export interface RunNotificationGate {
  readonly enabled: boolean;
  readonly supported: boolean;
  readonly windowFocused: boolean;
  readonly e2e: boolean;
}

export function shouldRaiseRunNotification(gate: RunNotificationGate): boolean {
  return gate.enabled && gate.supported && !gate.windowFocused && !gate.e2e;
}

export interface RunNotificationCopy {
  readonly title: string;
  readonly body: string;
}

const RUN_NOTIFICATION_COPY = {
  'zh-CN': {
    errored: { title: '任务出错', body: '本轮回答未能完成，点击查看详情。' },
    completed: { title: '回答已生成', body: 'Maka 已完成本轮回答，点击查看。' },
    waiting: { title: '等你回答', body: 'Maka 需要你的回答才能继续，点击查看。' },
  },
  'zh-TW': {
    errored: { title: '任務發生錯誤', body: '本次回答未能完成，按一下以檢視詳細資料。' },
    completed: { title: '回答已產生', body: 'Maka 已完成本次回答，按一下以檢視。' },
    waiting: { title: '等你回答', body: 'Maka 需要你的回答才能繼續，按一下以檢視。' },
  },
  en: {
    errored: { title: 'Conversation error', body: 'This response did not finish. Click to view details.' },
    completed: { title: 'Response ready', body: 'Maka finished this response. Click to view it.' },
    waiting: { title: 'Waiting for you', body: 'Maka needs your answer to continue. Click to view it.' },
  },
} satisfies UiCatalog<Record<SessionAttention['kind'], RunNotificationCopy>>;

export function runNotificationCopy(
  kind: SessionAttention['kind'],
  locale: UiLocale,
): RunNotificationCopy {
  return RUN_NOTIFICATION_COPY[locale][kind];
}

export interface RunNotificationEvent extends SessionAttention {
  readonly title?: string;
  readonly hostEpoch: string;
  readonly sessionId: string;
}

export function deduplicateRunNotifications(
  notify: (input: RunNotificationEvent) => Promise<void>,
): (input: RunNotificationEvent) => Promise<void> {
  const seen = new Set<string>();
  return async (input) => {
    const key = JSON.stringify([input.hostEpoch, input.sessionId, input.eventId]);
    if (seen.has(key)) return;
    // Owner and shared-session connections can deliver the same Host event.
    seen.add(key);
    if (seen.size > 512) seen.delete(seen.values().next().value!);
    await notify(input);
  };
}

const MAX_TITLE_CHARS = 80;
const MAX_BODY_CHARS = 160;

function sanitizeLine(value: string | undefined, max: number): string {
  const collapsed = (value ?? '').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

export function resolveNotificationContent(
  input: Pick<RunNotificationEvent, 'kind' | 'title' | 'body'>,
  locale: UiLocale,
): RunNotificationCopy {
  const fallback = runNotificationCopy(input.kind, locale);
  return {
    title: sanitizeLine(input.title, MAX_TITLE_CHARS) || fallback.title,
    body: sanitizeLine(input.body, MAX_BODY_CHARS) || fallback.body,
  };
}
