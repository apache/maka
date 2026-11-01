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
 * Bot Session subscribes; other Sessions make one head lookup and stop. Chat shows
 * nothing but these messages from the Bot, so a Turn with none simply shows none.
 */
/** Whether this Session is the Bot is `unknown` until the Host has said so. */
export type BotIdentity = 'unknown' | 'bot' | 'ordinary';
const IDENTITY_RETRY_MS = [500, 1500, 4000, 10000];

export function createBotTranscriptCore(
  host: BotHost,
  sessionId: string,
  changed: () => void,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  /** The Bot Session the application already knows: a string, `null` for none, `undefined` if unknown. */
  known: () => string | null | undefined = () => undefined,
) {
  const fromKnown = (): BotIdentity => {
    const bot = known();
    return bot === undefined ? 'unknown' : bot === sessionId ? 'bot' : 'ordinary';
  };
  let identity: BotIdentity = fromKnown();
  let byTurn: ReadonlyMap<string, BotTranscriptMessage[]> = new Map();
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
  // Only the watch loop reads, one page run at a time, so the cursor never races.
  const sync = async (): Promise<void> => {
    const head = await host.query('agent', 'botOutbox', { limit: 0 });
    if (!alive || head.sessionId !== sessionId) return;
    await catchUp(head.through);
  };

  let ready: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  /** Ask who the Bot is, retrying a failed lookup; a failure never decides "ordinary". */
  const identify = async (): Promise<boolean> => {
    for (let attempt = 0; alive; attempt++) {
      const prior = fromKnown();
      if (prior !== 'unknown') {
        identity = prior;
        changed();
        return identity === 'bot';
      }
      try {
        const head = await host.query('agent', 'botOutbox', { limit: 0 });
        if (!alive) return false;
        identity = head.sessionId === sessionId ? 'bot' : 'ordinary';
        changed();
        return identity === 'bot';
      } catch {
        const delay = IDENTITY_RETRY_MS[attempt];
        if (delay === undefined) return false;
        await wait(delay);
      }
    }
    return false;
  };
  // The watch starts once the Session is known to be the Bot. If every lookup failed
  // it ends unstarted, and a later answer from the application starts it (`resume`).
  let running = false;
  let identified = false;
  const run = async () => {
    running = true;
    try {
      if (!(await identify())) return;
      identified = true;
      const opened = await host.subscribe('agent', 'watchBotOutbox', { limit: 0 });
      if (!alive) {
        await opened.close();
        return;
      }
      stream = opened;
      ready();
      await sync().catch(() => {});
      for (;;) {
        const latest = await opened.next();
        if (!alive || latest === null) return;
        if (latest.sessionId === sessionId) await sync().catch(() => {});
        changed();
      }
    } catch {
      // The watch ended; what was read stays.
    } finally {
      running = false;
      ready();
    }
  };
  const resume = () => {
    if (alive && !running && !identified && fromKnown() === 'bot') void run();
  };
  void run();

  return {
    started,
    identity: (): BotIdentity => {
      if (identity !== 'unknown') return identity;
      resume();
      return fromKnown();
    },
    isBot: () => {
      if (identity === 'bot') return true;
      if (identity !== 'unknown') return false;
      resume();
      return fromKnown() === 'bot';
    },
    forTurn: (turnId: string): BotTranscriptMessage[] => byTurn.get(turnId) ?? [],
    close() {
      alive = false;
      const previous = stream;
      stream = null;
      if (previous) void previous.close().catch(() => {});
    },
  };
}

/**
 * How a finished Bot Turn ended, from what the user can see of it. Silence is a valid
 * outcome and needs no marker: `quiet` is a Turn that chose to sleep without sending.
 * `unanswered` is a Turn that ended with neither a `SendUser` message nor a `sleep`,
 * so the user cannot tell it from a deliberate silence unless Chat says so.
 */
export type BotTurnEnding = 'running' | 'replied' | 'quiet' | 'unanswered' | 'other';
export function botTurnEnding(turn: {
  /** The Turn has finished and is not the one running now. */
  finished: boolean;
  /** `completed`, `failed`, `aborted`, ... or null while unknown. */
  outcome: string | null;
  sent: boolean;
  slept: boolean;
}): BotTurnEnding {
  if (!turn.finished) return 'running';
  if (turn.sent) return 'replied';
  // A failure or a stop has its own row; only a completed Turn can be mistaken for silence.
  if (turn.outcome !== 'completed') return 'other';
  return turn.slept ? 'quiet' : 'unanswered';
}
