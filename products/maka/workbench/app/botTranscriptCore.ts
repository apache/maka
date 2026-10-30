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

/** What the Bot sent with `SendUser`, and what is known about each Turn's replies. */
type Query = (
  endpoint: 'agent',
  method: 'botOutbox',
  input: { after?: number; limit?: number },
) => Promise<{
  sessionId?: string | null;
  through: number;
  nextAfter?: number | null;
  messages: BotTranscriptMessage[];
}>;
type Subscribe = (
  endpoint: 'agent',
  method: 'watchBotOutbox',
  input: { limit: number },
) => Promise<{ next(): Promise<any | null>; close(): Promise<void> }>;
export type BotHost = { query: Query; subscribe: Subscribe };
export type BotTranscriptMessage = {
  sequence: number;
  messageId: string;
  index: number;
  text: string;
  at: number;
  turnId?: string;
};

/**
 * What the Bot deliberately told its user, grouped by the Turn that sent it. Only the
 * Bot Session subscribes; other Sessions make one head lookup and stop.
 *
 * A Turn that has no messages here is not thereby known to have sent none: the
 * pages may not have arrived or may have failed. `confirmedEmpty` is true only after
 * a read that reached the outbox head observed after the Turn ended.
 */
export function createBotTranscriptCore(host: BotHost, sessionId: string, changed: () => void) {
  let isBot = false;
  let byTurn: ReadonlyMap<string, BotTranscriptMessage[]> = new Map();
  let confirmed: ReadonlySet<string> = new Set();
  const asking = new Set<string>();
  let alive = true;
  let stream: { close(): Promise<void> } | null = null;
  let cursor = 0;

  const catchUp = async (through: number) => {
    while (alive && cursor < through) {
      const page = await host.query('agent', 'botOutbox', { after: cursor });
      if (!alive || page.sessionId !== sessionId || page.messages.length === 0) return;
      const next = new Map(byTurn);
      for (const message of page.messages) {
        cursor = message.sequence;
        if (!message.turnId) continue;
        next.set(message.turnId, [...(next.get(message.turnId) ?? []), message]);
      }
      byTurn = next;
      changed();
      if (page.nextAfter === null || page.nextAfter === undefined) return;
    }
  };
  // One read at a time. A request that arrives while one runs waits for a fresh
  // read, because the running one may have observed the head before the request.
  let running: Promise<boolean> | null = null;
  let queued: Promise<boolean> | null = null;
  const read = async (): Promise<boolean> => {
    const head = await host.query('agent', 'botOutbox', { limit: 0 });
    if (!alive || head.sessionId !== sessionId) return false;
    await catchUp(head.through);
    return alive && cursor >= head.through;
  };
  const sync = (): Promise<boolean> => {
    const start = () => {
      running = read().finally(() => {
        running = null;
      });
      return running;
    };
    if (running === null) return start();
    if (queued === null) {
      queued = running
        .catch(() => false)
        .then(() => {
          queued = null;
          return start();
        });
    }
    return queued;
  };

  let ready: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  void (async () => {
    try {
      const head = await host.query('agent', 'botOutbox', { limit: 0 });
      if (!alive || head.sessionId !== sessionId) return;
      isBot = true;
      changed();
      const opened = await host.subscribe('agent', 'watchBotOutbox', { limit: 0 });
      if (!alive) {
        await opened.close();
        return;
      }
      stream = opened;
      void sync().catch(() => {});
      ready();
      for (;;) {
        const latest = await opened.next();
        if (!alive || latest === null) return;
        if (latest.sessionId === sessionId) await sync().catch(() => {});
        changed();
      }
    } catch {
      // Not the Bot Session, or the Bot mode is off: the conversation stays ordinary.
    } finally {
      ready();
    }
  })();

  return {
    started,
    isBot: () => isBot,
    forTurn: (turnId: string): BotTranscriptMessage[] => byTurn.get(turnId) ?? [],
    confirmedEmpty: (turnId: string) => confirmed.has(turnId),
    /** Confirm that a finished Turn sent nothing; a failed read confirms nothing. */
    confirm(turnId: string): Promise<void> {
      if (!isBot || asking.has(turnId) || confirmed.has(turnId) || byTurn.has(turnId))
        return Promise.resolve();
      asking.add(turnId);
      return sync()
        .then((reached) => {
          if (reached && alive && !byTurn.has(turnId)) {
            confirmed = new Set(confirmed).add(turnId);
            changed();
          }
        })
        .catch(() => {})
        .finally(() => {
          asking.delete(turnId);
        });
    },
    close() {
      alive = false;
      const previous = stream;
      stream = null;
      if (previous) void previous.close().catch(() => {});
    },
  };
}
