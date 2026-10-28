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

// The desktop window's notifications: a conversation in the list that stops
// working, or starts waiting for the user, while the window is in the
// background. Choosing one shows that conversation. Terminals have none.
import { cleanup, effect, host as shell, untracked } from 'nsh';
import type { BrowserSession } from './browsing';
import { ownTitleBar } from './chrome';
import { tr } from './locale';
import { sessionStatusCaption } from './sessionStatus';

export function watchNotifications(props: {
  sessions(): BrowserSession[];
  foreground(): boolean;
  open(sessionId: string): void;
}) {
  if (!ownTitleBar) return;
  // Activity as last seen: a conversation's first appearance (a page loaded,
  // a scope chosen) is not a change.
  const seen = new Map<string, BrowserSession['activity']>();
  effect(() => {
    const sessions = props.sessions();
    const background = !untracked(props.foreground);
    for (const session of sessions) {
      const before = seen.get(session.id);
      seen.set(session.id, session.activity);
      if (!background || before === undefined || before === session.activity) continue;
      const body =
        session.activity === 'waiting'
          ? sessionStatusCaption.waiting
          : before === 'working' && session.activity === 'idle'
            ? tr('Turn finished')
            : null;
      if (body === null) continue;
      void shell
        .call('notification.show', {
          tag: session.id,
          title: session.title || tr('Untitled conversation'),
          body,
        })
        .catch(() => undefined);
    }
  });
  const opened = shell.on('notification.open', (data: { tag?: unknown }) => {
    if (typeof data?.tag === 'string') props.open(data.tag);
  });
  cleanup(() => opened.remove());
}
