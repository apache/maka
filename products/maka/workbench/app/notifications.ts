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
// background, plus Discovery interrupts. Choosing one shows that target.
// Terminals have none.
import {
  batch,
  cleanup,
  computed,
  effect,
  type NotificationPermission,
  Notifications,
  signal,
  untracked,
} from 'nsh';
import { Window } from 'nsh/desktop';
import type { BrowserSession } from './browsing';
import type { Host } from './host';
import {
  dossierInterrupt,
  notificationTarget,
  type DossiersSnapshot,
} from './discoveryDossiersCore';
import { observeDiscovery } from './discoveryObservation';
import { ownTitleBar } from './chrome';
import { tr } from './locale';
import { sessionStatusCaption } from './sessionStatus';
import { createText, errorText } from './text';

let checking: Promise<NotificationPermission> | undefined;
let requested = false;

function resolvePermission(): Promise<NotificationPermission> {
  return (checking ??= Notifications.permission()
    .then((status) => {
      if (status !== 'default' || requested) return status;
      requested = true;
      return Notifications.requestPermission();
    })
    .finally(() => {
      checking = undefined;
    }));
}

export function watchDiscoveryDossiers(host: Host, viewOpen: () => boolean) {
  const snapshot = signal<DossiersSnapshot | null>(null);
  const error = createText();
  const active = computed(() => ownTitleBar || viewOpen());
  effect(() => {
    if (!active()) return;
    let seen: ReadonlyMap<string, number> | null = null;
    let alive = true;
    const stop = observeDiscovery(
      () => host.subscribe('agent', 'watchDossiers', {}),
      (update, first) => {
        batch(() => {
          snapshot.set(update);
          error.set('');
        });
        if (!ownTitleBar) return;
        const next = dossierInterrupt(first ? null : seen, update);
        seen = next.seen;
        if (!next.notifications.length) return;
        void resolvePermission()
          .then((status) => {
            if (status !== 'granted' || !alive) return;
            for (const notice of next.notifications) {
              void Notifications.show({
                id: notice.tag,
                title: notice.title,
                body: notice.body || tr('Discovery interrupt'),
              }).catch((reason) => console.warn('Could not show Discovery notification', reason));
            }
          })
          .catch((reason) => console.warn('Could not show Discovery notification', reason));
      },
      (reason) => error.set(errorText(reason, 'Discovery connection interrupted')),
    );
    return () => {
      alive = false;
      stop();
    };
  });
  return { snapshot, error };
}

export function watchNotifications(props: {
  sessions(): BrowserSession[];
  foreground(): boolean;
  open(sessionId: string): void;
  openDiscovery?(topicId: string): void;
}) {
  if (!ownTitleBar) return;
  let seen = new Map<string, BrowserSession['activity']>();
  let pending = new Map<string, BrowserSession>();
  let delivering = false;
  let disposed = false;
  cleanup(() => {
    disposed = true;
    pending.clear();
  });
  cleanup(
    Notifications.on('press', ({ id }) => {
      Window.get('main')?.focus();
      const target = notificationTarget(id);
      if (target?.kind === 'discovery') props.openDiscovery?.(target.id);
      else if (target) props.open(target.id);
    }),
  );

  async function deliver() {
    delivering = true;
    try {
      if ((await resolvePermission()) !== 'granted' || disposed || untracked(props.foreground))
        return;
      for (const { id, title, activity } of pending.values()) {
        void Notifications.show({
          id,
          title: title || tr('Untitled conversation'),
          body: activity === 'waiting' ? sessionStatusCaption.waiting : tr('Turn finished'),
        }).catch((reason) => console.warn('Could not show notification:', reason));
      }
    } catch (reason) {
      console.warn('Could not check notification permission:', reason);
    } finally {
      pending.clear();
      delivering = false;
    }
  }

  effect(() => {
    if (props.foreground()) pending.clear();
  });
  effect(() => {
    const background = !untracked(props.foreground);
    const previous = seen;
    const previousPending = pending;
    seen = new Map();
    pending = new Map();
    for (const session of props.sessions()) {
      const { id, activity } = session;
      const before = previous.get(id);
      seen.set(id, activity);
      if (!background || before === undefined) continue;
      const notify =
        before === activity
          ? previousPending.has(id)
          : activity === 'waiting' || (before === 'working' && activity === 'idle');
      if (notify) pending.set(id, session);
    }
    if (pending.size && !delivering) void deliver();
  });
}
