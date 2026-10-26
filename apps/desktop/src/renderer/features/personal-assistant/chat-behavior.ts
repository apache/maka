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

import type { AssistantAvatar } from '@maka/runtime-host/protocol';
import type { StoredMessage } from '@maka/core/session';

/** Background Bot work is not a reply. Only show typing after an unanswered human message. */
export function hasPendingAssistantReply(messages: readonly (Pick<StoredMessage, 'type'> & { origin?: unknown })[]): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.type === 'assistant') return false;
    if (message.type === 'user') return !message.origin;
  }
  return false;
}

export function dismissComposerConfiguration(root: HTMLElement, event: Event): void {
  const details = root.querySelector<HTMLDetailsElement>('details.maka-composer-configuration[open]');
  if (!details) return;
  if (event.type === 'keydown') {
    if ((event as KeyboardEvent).key !== 'Escape' || event.defaultPrevented) return;
    details.open = false;
    details.querySelector('summary')?.focus();
    event.preventDefault();
  } else if (event.type === 'pointerdown' && !event.composedPath().includes(details)) {
    details.open = false;
  }
}

/** Preserve identity on repeated disconnect polls while still clearing another Host's avatar. */
export function disconnectedAvatarState<T extends AssistantAvatar>(
  old: { scope?: string; avatar: T }, scope: string | undefined, fallback: T,
): { scope?: string; avatar: T } {
  return old.scope === scope && old.avatar === fallback ? old : { scope, avatar: fallback };
}
