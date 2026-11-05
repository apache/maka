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
  input: { after?: number; limit?: number; sessionId?: string },
) => Promise<{
  /** The current Bot, whichever Session was asked about. */
  sessionId?: string | null;
  /** Whether the asked Session is, or once was, a Bot Session. */
  isBot: boolean;
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
  // Only "this is the current Bot" is settled without asking: any other Session may be a
  // Bot that was replaced, which only the Host's records can say.
  const fromKnown = (): BotIdentity => (known() === sessionId ? 'bot' : 'unknown');
  let identity: BotIdentity = fromKnown();
  /** Whether this Session is the Bot now; a replaced Bot is read once and not watched. */
  let current = identity === 'bot';
  let byTurn: ReadonlyMap<string, BotTranscriptMessage[]> = new Map();
  let alive = true;
  let stream: { close(): Promise<void> } | null = null;
  let cursor = 0;

  const catchUp = async (through: number) => {
    while (alive && cursor < through) {
      const page = await host.query('agent', 'botOutbox', { after: cursor, sessionId });
      if (!alive || !page.isBot || page.messages.length === 0) return;
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
    const head = await host.query('agent', 'botOutbox', { limit: 0, sessionId });
    if (!alive || !head.isBot) return;
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
        current = true;
        changed();
        return identity === 'bot';
      }
      try {
        const head = await host.query('agent', 'botOutbox', { limit: 0, sessionId });
        if (!alive) return false;
        // A replaced Bot still reads as a Bot, so its replies stay what the user saw.
        identity = head.isBot ? 'bot' : 'ordinary';
        current = head.sessionId === sessionId;
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
      if (!current) {
        await sync().catch(() => {});
        changed();
        return;
      }
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

/**
 * The worker a Bot Turn reports, when the Bot started that Turn because the worker
 * finished a run: the Host marks the Turn's opening message with the worker as its origin.
 */
export function reportedWorker(
  rows: Iterable<{ turnId?: string; origin?: { kind: string; sessionId?: string } }>,
  turnId: string,
): string | undefined {
  for (const row of rows)
    if (row.turnId === turnId && row.origin?.kind === 'bot_worker') return row.origin.sessionId;
  return undefined;
}

/** The most pages read for one window, so a Bot with a very long history cannot loop the read. */
const MAX_PAGES = 16;
type Session = { id: string };
type Page<S extends Session = Session> = { revision: string; after?: string | null; sessions: S[] };

/**
 * Every session of one catalog window, following its continuation cursor. The catalog
 * pages by recency, so a running or waiting worker may sit behind a full page of idle
 * ones. A page of another revision means the catalog moved; the caller waits for the
 * window that the subscription pushes next.
 */
export async function assembleChildren<S extends Session, P extends Page<S>>(
  first: P,
  next: (page: P) => Promise<P>,
): Promise<S[]> {
  const rows = new Map(first.sessions.map((session) => [session.id, session]));
  let tail = first;
  for (let pages = 1; tail.after && pages < MAX_PAGES; pages += 1) {
    const page = await next(tail);
    if (page.revision !== first.revision) throw new Error('agent_catalog_changed');
    if (page.after === tail.after) break;
    for (const session of page.sessions) rows.set(session.id, session);
    tail = page;
  }
  return [...rows.values()];
}

export type ActiveWorker = { id: string; title: string; activity: 'working' | 'waiting' };
/**
 * The conversations the Bot created that are running, or waiting for the user, now. Such a
 * conversation has not ended its run, so the Bot is not woken and says nothing about it.
 */
export function activeWorkers<
  T extends {
    id: string;
    title: string;
    parentSessionId: string | null;
    activity: string;
    archived: boolean;
  },
>(sessions: readonly T[], bot: string | null | undefined): ActiveWorker[] {
  if (!bot) return [];
  const found: ActiveWorker[] = [];
  for (const session of sessions) {
    if (session.parentSessionId !== bot || session.archived) continue;
    if (session.activity === 'working' || session.activity === 'waiting')
      found.push({ id: session.id, title: session.title, activity: session.activity });
  }
  // What waits for the user comes first.
  return found.sort((a, b) => Number(b.activity === 'waiting') - Number(a.activity === 'waiting'));
}
