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
import type {
  ServiceMethods,
  QuoteRef,
  AgentWorkerProgress,
} from '../../../../packages/plugin-sdk/src/index.js';

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
  discoveryLink?: ServiceMethods['agent']['botOutbox']['output']['discoveryLink'];
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
  discovery?: ServiceMethods['agent']['botOutbox']['output']['messages'][number]['discovery'];
  sequence: number;
  messageId: string;
  index: number;
  text: string;
  at: number;
  turnId?: string;
};

export function quoteBotMessage(
  message: BotTranscriptMessage,
  sessionId: string,
  name: string,
  text: string,
  at: number,
): QuoteRef {
  return {
    text,
    label: name,
    sourceMessageId: `bot/${message.sequence}`,
    sourceTurnId: message.turnId,
    source: { sessionId, sessionName: name, capturedAt: at, truncated: false },
  };
}

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
  let linkRevision = 0;
  let latest: BotTranscriptMessage | null = null;

  const catchUp = async (through: number, rebuild = false) => {
    let after = rebuild ? 0 : cursor;
    let turns = rebuild ? new Map<string, BotTranscriptMessage[]>() : byTurn;
    let last = rebuild ? null : latest;
    while (alive && after < through) {
      const page = await host.query('agent', 'botOutbox', { after, sessionId });
      if (!alive || !page.isBot || page.messages.length === 0) return false;
      const next = new Map(turns);
      for (const message of page.messages) {
        after = message.sequence;
        if (!message.turnId) continue;
        last = message;
        next.set(message.turnId, [...(next.get(message.turnId) ?? []), message]);
      }
      turns = next;
      if (!rebuild || after >= through || page.nextAfter == null) {
        cursor = after;
        byTurn = turns;
        latest = last;
        changed();
      }
      if (page.nextAfter == null) break;
    }
    return true;
  };
  // Only the watch loop reads, one page run at a time, so the cursor never races.
  const sync = async (): Promise<void> => {
    const head = await host.query('agent', 'botOutbox', { limit: 0, sessionId });
    if (!alive || !head.isBot) return;
    const link = head.discoveryLink;
    if (link && link.revision !== linkRevision) {
      if (cursor && link.revision !== linkRevision + 1) {
        // After missed link edits, keep the old transcript visible until all replacement pages arrive.
        if (await catchUp(head.through, true)) linkRevision = link.revision;
        return;
      }
      const turn = link.turnId && byTurn.get(link.turnId);
      if (link.turnId && turn) {
        const update = (m: BotTranscriptMessage) =>
          m.messageId === link.messageId ? { ...m, discovery: link.discovery } : m;
        byTurn = new Map(byTurn).set(link.turnId, turn.map(update));
        if (latest) latest = update(latest);
        changed();
      }
      linkRevision = link.revision;
    }
    await catchUp(head.through);
  };

  let ready: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let resolveIdentified: () => void = () => {};
  const whenIdentified = new Promise<void>((resolve) => {
    resolveIdentified = resolve;
  });
  /** Ask who the Bot is, retrying a failed lookup; a failure never decides "ordinary". */
  const identify = async (): Promise<boolean> => {
    try {
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
    } finally {
      resolveIdentified();
    }
  };
  // The watch starts once the Session is known to be the Bot. If every lookup failed
  // it ends unstarted, and a later answer from the application starts it (`resume`).
  const isObservationCancelled = (reason: unknown): boolean => {
    const detail = reason instanceof Error ? reason.message : String(reason);
    return detail === 'client subscription cancelled' || detail.endsWith('_observation_cancelled');
  };
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
      for (let reconnects = 0; alive; ) {
        let opened: Awaited<ReturnType<Subscribe>> | null = null;
        try {
          opened = await host.subscribe('agent', 'watchBotOutbox', { limit: 0 });
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
            reconnects = 0;
            if (latest.sessionId === sessionId) await sync().catch(() => {});
            changed();
          }
        } catch (reason) {
          if (!alive) return;
          if (isObservationCancelled(reason) && reconnects < 3) {
            reconnects += 1;
            if (reconnects > 1) await wait(250 * reconnects);
            continue;
          }
          throw reason;
        } finally {
          if (opened && stream === opened) {
            stream = null;
            await opened.close().catch(() => {});
          }
        }
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
    whenIdentified,
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
    latest: () => latest,
    close() {
      alive = false;
      resolveIdentified();
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
/**
 * Bot Chat shows only what the user said and what the Bot published via `SendUser`.
 * Model replies and host-authored user turns (worker completions, scheduled runs) stay
 * in Trajectory.
 */
export function botChatHidesRow(row: { role: string; origin?: { kind: string } | null }): boolean {
  return (
    row.role === 'assistant' ||
    (row.role === 'user' && row.origin != null && row.origin.kind !== 'session')
  );
}

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
    if (
      row.turnId === turnId &&
      (row.origin?.kind === 'bot_worker' ||
        row.origin?.kind === 'discovery_report' ||
        row.origin?.kind === 'session_completion')
    )
      return row.origin.sessionId;
  return undefined;
}

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
  const seen = new Set<string>();
  let tail = first;
  while (tail.after && !seen.has(tail.after)) {
    seen.add(tail.after);
    const page = await next(tail);
    if (page.revision !== first.revision) throw new Error('agent_catalog_changed');
    if (page.after === tail.after) break;
    for (const session of page.sessions) rows.set(session.id, session);
    tail = page;
  }
  return [...rows.values()];
}

export type ActiveWorker = {
  id: string;
  title: string;
  activity: 'working' | 'waiting';
  progress?: AgentWorkerProgress;
};
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
>(
  sessions: readonly T[],
  bot: string | null | undefined,
  progress?: ReadonlyMap<string, AgentWorkerProgress>,
): ActiveWorker[] {
  if (!bot) return [];
  const found: ActiveWorker[] = [];
  for (const session of sessions) {
    if (session.parentSessionId !== bot || session.archived) continue;
    const live = progress?.get(session.id);
    if (session.activity === 'working' || session.activity === 'waiting') {
      const waiting = live && ['approval', 'question', 'permission', 'form'].includes(live.kind);
      found.push({
        id: session.id,
        title: session.title,
        activity: live ? (waiting ? 'waiting' : 'working') : session.activity,
        ...(live ? { progress: live } : {}),
      });
    }
  }
  // What waits for the user comes first.
  return found.sort((a, b) => Number(b.activity === 'waiting') - Number(a.activity === 'waiting'));
}
