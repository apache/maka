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

import { cleanup, signal, host as surfaceHost } from 'nsh';
import { host } from 'maka/host';
import type { Output } from '../../../../products/maka/workbench/app/host';
type AgentBotOutbox = Output<'agent', 'botOutbox'>;

/** One durable Host-owned outbox shared by the main window and the quick panel. */
export function createAssistantInbox(report: (error: unknown) => void) {
  const sessionId = signal<string | null>(null),
    unread = signal(0),
    preview = signal('');
  if (surfaceHost.params.quickToolsPanel !== true) return { sessionId, unread, preview };
  let alive = true;
  let outbox: { next(): Promise<unknown>; close(): Promise<void> } | undefined;
  cleanup(() => {
    alive = false;
    void outbox?.close().catch(() => {});
  });
  let watching = false;
  const watch = async () => {
    if (!alive || watching) return;
    watching = true;
    try {
      const stream = await host.subscribe('agent', 'watchBotOutbox', { limit: 0 });
      if (!alive) {
        await stream.close();
        return;
      }
      outbox = stream;
      for (;;) {
        const head = (await stream.next()) as AgentBotOutbox | null;
        if (!alive || !head) return;
        sessionId.set(head.sessionId ?? null);
        unread.set(head.isBot ? Math.max(0, head.through - head.readThrough) : 0);
        preview.set(head.preview);
      }
    } catch (error) {
      if (alive) report(error);
    } finally {
      const stream = outbox;
      outbox = undefined;
      await stream?.close().catch(() => {});
      watching = false;
    }
  };
  // A host restart can end an observation. Reopen it on the next reveal and
  // read the durable outbox head before displaying the unread count.
  cleanup(
    surfaceHost.on('quickTools.visibility', (event) => {
      if ((event as { visible: boolean }).visible) void watch();
    }),
  );
  void watch();
  return { sessionId, unread, preview };
}
