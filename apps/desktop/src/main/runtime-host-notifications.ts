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

import type { DesktopRuntimeHostClient } from './runtime-host-client.js';
import type { RunNotificationEvent } from './notifications-policy.js';

export function observeRuntimeHostNotifications(
  client: Pick<DesktopRuntimeHostClient, 'hostEpoch' | 'subscribeSessionCatalogChanges' | 'getSession' | 'getSharedSession'>,
  notify: (input: RunNotificationEvent) => Promise<void>,
  onError: (error: unknown) => void,
  shared = false,
): () => void {
  let closed = false;
  const unsubscribe = client.subscribeSessionCatalogChanges((frame) => {
    if (!frame.attention || closed) return;
    const attention = frame.attention;
    const hostEpoch = client.hostEpoch;
    void (shared ? client.getSharedSession() : client.getSession(frame.sessionId))
      .catch(() => null)
      .then((session) => {
        if (closed) return;
        return notify({
          hostEpoch,
          sessionId: frame.sessionId,
          eventId: attention.eventId,
          kind: attention.kind,
          title: session?.name,
          body: attention.body ?? session?.lastMessagePreview,
        });
      }).catch(onError);
  });
  return () => {
    closed = true;
    unsubscribe();
  };
}
