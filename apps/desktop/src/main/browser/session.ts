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

import { CDPBridge } from '@jackwener/opencli/browser/cdp';
import type { IPage } from '@jackwener/opencli/types';
import {
  type BrowserOriginLease,
  browserAutomationAvailable,
  browserViewHost,
} from './browser-host.js';
import { type BrowserActionKind, parseNavigable } from './logic.js';

/**
 * Owner of the live CDP connection into a conversation's embedded browser.
 *
 * One connection per CONVERSATION: views (and their sealed ws bridges) belong
 * to a session, so session → endpoint is the identity mapping. Maka sessions
 * are FLAT (no parent chain), so the session id IS the conversation id — no
 * root-session walk, unlike PawWork. The connection is torn down when the
 * session is deleted or archived (releaseBrowserSession).
 *
 * opencli's CDPBridge.connect() registers its stealth script via
 * Page.addScriptToEvaluateOnNewDocument, which only affects FUTURE documents.
 * Connecting before the view's first navigation covers the agent-first flow;
 * when the agent takes over a page the user already opened, that page predates
 * the script. It is reloaded once to harden it — but ONLY before the first
 * mutating action (click/type), never before a pure observe (snapshot / extract
 * / wait), so the agent merely looking at a page the user has open
 * cannot wipe their unsaved input. A navigation re-commits with the script, so
 * it just clears the pending takeover without a reload. (Reload is the only
 * contract-clean path — the stealth source itself is not a public export.)
 */

/** Shorter than opencli's internal 30s CDP guard so tools fail first, with a browser-flavored message. */
export const BROWSER_TOOL_TIMEOUT_MS = 25_000;

/** Best-effort wait for the takeover reload to settle; navigation events keep flowing afterwards either way. */
const TAKEOVER_RELOAD_TIMEOUT_MS = 10_000;

export class BrowserToolTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(
      `Browser ${label} timed out after ${Math.round(ms / 1000)}s. The page may still be loading; try browser_wait or a simpler action.`,
    );
    this.name = 'BrowserToolTimeoutError';
  }
}

export class BrowserActionCanceledError extends Error {
  constructor(label: string) {
    super(`Browser ${label} was canceled.`);
    this.name = 'BrowserActionCanceledError';
  }
}

export class BrowserActionBlockedError extends Error {
  constructor(label: string) {
    super(
      `Browser ${label} blocked: the agent can only read, navigate, or act on the embedded browser while ` +
        `this conversation is the one on screen. Ask the user to switch back to this conversation (and keep ` +
        `its browser panel open) to continue.`,
    );
    this.name = 'BrowserActionBlockedError';
  }
}

export class BrowserActionRevokedError extends Error {
  constructor(label: string) {
    super(
      `Browser ${label} stopped: the user switched away from this conversation mid-action, so the agent can no ` +
        `longer read or drive a page they can't see. Ask the user to switch back to this conversation to continue.`,
    );
    this.name = 'BrowserActionRevokedError';
  }
}

/**
 * The slice of opencli's CDPBridge that BrowserSession drives. Prod uses the
 * real bridge; tests inject a fake so the connection lifecycle (loss,
 * takeover-reload, abort-sever) is deterministic without a live CDP endpoint.
 */
export interface BridgeLike {
  connect(opts: { cdpEndpoint: string }): Promise<IPage>;
  close(): Promise<void>;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  waitForEvent(event: string, timeoutMs?: number): Promise<unknown>;
}

let createBridge: () => BridgeLike = () => new CDPBridge();

/** Test seam: swap the bridge factory; pass null to restore the real one. */
export function setBridgeFactoryForTest(factory: (() => BridgeLike) | null): void {
  createBridge = factory ?? (() => new CDPBridge());
}

type Connection = {
  /** Owning session — 1:1 with its conversation's view and endpoint. */
  session: string;
  bridge: BridgeLike;
  page: IPage;
  closed: boolean;
  /**
   * connect() attached to an already-committed page that predates the stealth
   * script and still owes one hardening reload. Resolved lazily by
   * withBrowserPage: the first mutating action reloads (observe never does), and
   * a navigation clears it without a reload (goto re-commits with the script).
   */
  pendingTakeover: boolean;
};

/**
 * How an action resolves a pending takeover (see Connection.pendingTakeover).
 * Shares the visible-lease kind (logic.ts): the action's effect on the page is
 * the same axis that gates whether it may reach a hidden view.
 */
export type TakeoverMode = BrowserActionKind;

const bySession = new Map<string, Connection>();
// In-flight first acquires: the underlying ws bridge accepts a single client,
// so two concurrent first calls for one conversation must share one attempt
// instead of racing into a second connection (which the bridge would reject).
const pendingAcquires = new Map<string, Promise<Connection>>();
// Release epoch per conversation. A delete/archive cannot reliably see an
// in-flight acquire, so instead of the release waiting on the acquire, the
// acquire notices the bump after connecting and unwinds itself — otherwise its
// resolveEndpoint would resurrect the just-disposed view and the connection
// would outlive the conversation with nothing left to ever clean it up.
const releaseEpochs = new Map<string, number>();
// In-flight actions per conversation, so the visible lease can REVOKE — not just
// preflight. canDrive gates the START on screen; this severs an action that was
// still running when the user switched away (browser:active-session), so a
// wait / navigate / extract / mutate can never keep reading or driving a now-
// hidden, logged-in page. Keyed by session because only the shown conversation
// may have one in flight, but a Set tolerates overlap defensively.
const inFlightBySession = new Map<string, Set<AbortController>>();

function trackInFlight(sessionId: string): AbortController {
  const ctrl = new AbortController();
  const set = inFlightBySession.get(sessionId) ?? new Set<AbortController>();
  set.add(ctrl);
  inFlightBySession.set(sessionId, set);
  return ctrl;
}

function untrackInFlight(sessionId: string, ctrl: AbortController): void {
  const set = inFlightBySession.get(sessionId);
  if (!set) return;
  set.delete(ctrl);
  if (set.size === 0) inFlightBySession.delete(sessionId);
}

/**
 * The window switched to `shownSessionId` (or to nothing): abort any browser
 * action still running for a DIFFERENT conversation. The visible lease is
 * continuous, not a one-time preflight — an action that started while visible
 * must not keep reading or driving a page the user can no longer see. Severs the
 * connection like a timeout/abort; the page itself survives for when the user
 * switches back. Called from main's browser:active-session handler.
 */
export function revokeHiddenBrowserActions(shownSessionId: string | null): void {
  for (const [sessionId, set] of inFlightBySession) {
    if (sessionId === shownSessionId) continue;
    for (const ctrl of set) ctrl.abort();
  }
}

// Every way the underlying connection reports being gone: opencli's send()
// pre-check ("CDP connection is not open"), its close() ("CDP connection
// closed"), and the main-process bridge failing in-flight commands on teardown
// ("bridge closed").
const CONNECTION_LOST = /CDP connection is not open|CDP connection closed|bridge closed/i;

function isConnectionLoss(err: unknown): boolean {
  return err instanceof Error && CONNECTION_LOST.test(err.message);
}

async function currentPageUrl(page: IPage): Promise<string | null> {
  if (page.getCurrentUrl) return page.getCurrentUrl();
  try {
    const url = await page.evaluate<string>('window.location.href');
    return typeof url === 'string' ? url : null;
  } catch {
    return null;
  }
}

async function connect(session: string, endpoint: string): Promise<Connection> {
  const bridge = createBridge();
  const page = await bridge.connect({ cdpEndpoint: endpoint });
  // An already-committed navigable page predates the stealth script, so it owes
  // a hardening reload. Don't reload now: connect() can't tell whether the agent
  // is about to observe or mutate, and observing must never disturb a page the
  // user may have unsaved input on. withBrowserPage resolves the takeover.
  const url = await currentPageUrl(page);
  const pendingTakeover = Boolean(url && parseNavigable(url));
  return { session, bridge, page, closed: false, pendingTakeover };
}

// Reload the taken-over page once so its current document gets the stealth
// script (addScriptToEvaluateOnNewDocument only affects future documents).
async function applyTakeoverReload(conn: Connection): Promise<void> {
  const loaded = conn.bridge.waitForEvent('Page.loadEventFired', TAKEOVER_RELOAD_TIMEOUT_MS).catch(() => undefined);
  await conn.bridge.send('Page.reload', {});
  await loaded;
}

function invalidate(conn: Connection): void {
  if (conn.closed) return;
  conn.closed = true;
  bySession.delete(conn.session);
  void conn.bridge.close().catch(() => {});
  // Tell the main process to drop its attachment now: with the bySession
  // mapping gone, a later session delete/archive can no longer do it, and the
  // host would keep a stale bridge alive forever. Best-effort — a re-acquire
  // re-attaches regardless.
  if (browserAutomationAvailable()) {
    void browserViewHost()
      .releaseSession(conn.session)
      .catch(() => {});
  }
}

async function acquire(sessionId: string): Promise<Connection> {
  const cached = bySession.get(sessionId);
  if (cached && !cached.closed) return cached;

  // Single-flight per conversation: a failed attempt clears itself so the next
  // call retries fresh; concurrent callers share the same outcome either way.
  const inflight = pendingAcquires.get(sessionId);
  if (inflight) return inflight;
  const promise = (async () => {
    const epoch = releaseEpochs.get(sessionId);
    const endpoint = await browserViewHost().resolveEndpoint(sessionId);
    let conn: Connection;
    try {
      conn = await connect(sessionId, endpoint.cdpEndpoint);
    } catch (err) {
      // resolveEndpoint already attached the host's bridge, but nothing on this
      // side maps the session yet — a later release would no-op and leak the
      // attachment. Undo it now.
      await browserViewHost()
        .releaseSession(sessionId)
        .catch(() => {});
      throw err;
    }
    if (releaseEpochs.get(sessionId) !== epoch) {
      // The conversation was deleted or archived while we were connecting —
      // resolveEndpoint resurrected its view after the release disposed it.
      // Unwind completely: close the socket, dispose the recreated view.
      conn.closed = true;
      await conn.bridge.close().catch(() => {});
      await browserViewHost()
        .disposeSession(sessionId)
        .catch(() => {});
      throw new Error('The conversation was deleted while the browser was connecting.');
    }
    bySession.set(sessionId, conn);
    return conn;
  })().finally(() => pendingAcquires.delete(sessionId));
  pendingAcquires.set(sessionId, promise);
  return promise;
}

export type BrowserPageRun<T> = (
  page: IPage,
  info: { takeoverReloaded: boolean; originLease?: BrowserOriginLease },
) => Promise<T>;

/**
 * Run one tool action against the session's embedded-browser page: lazy connect
 * + cache, a tool-level timeout that beats opencli's internal 30s guard, and
 * cache invalidation on connection loss so the next call re-resolves and
 * reconnects instead of failing forever.
 */
export async function withBrowserPage<T>(
  sessionId: string,
  label: string,
  run: BrowserPageRun<T>,
  opts?: {
    timeoutMs?: number;
    abort?: AbortSignal;
    takeover?: TakeoverMode;
    originAdmission?: { approvedUrl: string };
  },
): Promise<T> {
  if (opts?.abort?.aborted) throw new BrowserActionCanceledError(label);
  const kind: TakeoverMode = opts?.takeover ?? 'observe';
  // Visible-lease gate (browserActionAllowed): EVERY action — read, navigate, or
  // mutate — must target the conversation on screen, so the agent can never drive
  // (or even read) a view the user can't see. Runs BEFORE acquire, so a vetoed
  // background action creates no view and opens no connection. For a mutate whose
  // viewport is briefly absent (a permission modal just closed), canDrive waits
  // out the renderer's strip restore so the first approved click/type lands;
  // abort during that wait surfaces as a cancel, not a block. The lease is also
  // CONTINUOUS: revokeHiddenBrowserActions severs this action mid-run if the user
  // switches away before it finishes (see trackInFlight below).
  const drivable = await browserViewHost().canDrive(sessionId, kind, { signal: opts?.abort });
  if (opts?.abort?.aborted) throw new BrowserActionCanceledError(label);
  if (!drivable) throw new BrowserActionBlockedError(label);
  const ms = opts?.timeoutMs ?? BROWSER_TOOL_TIMEOUT_MS;
  let conn: Connection | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let onRevoke: (() => void) | undefined;
  // Establish the page-host Origin lease before endpoint acquisition and a
  // possible takeover reload. This closes the Provider-check → first-page-await
  // gap, while still preserving canDrive's rule that a blocked action creates
  // no view.
  const originLease = opts?.originAdmission
    ? browserViewHost().openOriginLease(sessionId, opts.originAdmission.approvedUrl, kind)
    : undefined;
  // Track this action so a switch away from the conversation can revoke it (the
  // visible lease is continuous, not just the preflight canDrive above).
  // Registered AFTER canDrive resolved true, with no await between, so the
  // active-session IPC can't slip a revoke into the gap.
  const revoke = trackInFlight(sessionId);
  // Abort, timeout, and revoke don't just stop the wait — they sever the
  // connection. CDP has no command-level cancel, so an orphaned run() would
  // otherwise keep driving the page after the user hit stop, switched away, or
  // after the tool already reported failure. Closing the socket fails its
  // in-flight and subsequent commands locally; the next action re-probes and
  // reconnects.
  //
  // The race covers acquire() too — the first action's endpoint resolution and
  // CDP connect answer to the same budget and the same stop button. The abort
  // listener registers BEFORE acquire on purpose: a signal that fires mid-
  // acquire would never fire a listener added after it ("abort" does not re-fire
  // on already-aborted signals), and the canceled action would run anyway.
  // Severing is conditional because there is no connection until acquire
  // returns; an abandoned in-flight acquire settles in the background and only
  // fills the cache for the next action.
  const interrupted = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      if (conn) invalidate(conn);
      reject(new BrowserToolTimeoutError(label, ms));
    }, ms);
    onAbort = () => {
      if (conn) invalidate(conn);
      reject(new BrowserActionCanceledError(label));
    };
    opts?.abort?.addEventListener('abort', onAbort, { once: true });
    onRevoke = () => {
      if (conn) invalidate(conn);
      reject(new BrowserActionRevokedError(label));
    };
    revoke.signal.addEventListener('abort', onRevoke, { once: true });
  });
  try {
    const acquiring = acquire(sessionId);
    // The race abandons this promise when interrupted wins; its eventual
    // rejection must not surface as an unhandled error.
    acquiring.catch(() => {});
    conn = await Promise.race([acquiring, interrupted]);
    // Resolve a pending takeover by the action's kind: a mutating action hardens
    // the page first (reload), a navigation just clears it (goto re-commits with
    // the script), and a pure observe leaves it pending so a later mutate still
    // hardens — observing never reloads the page the user has open.
    let takeoverReloaded = false;
    if (conn.pendingTakeover) {
      if (kind === 'mutate') {
        await Promise.race([applyTakeoverReload(conn), interrupted]);
        conn.pendingTakeover = false;
        takeoverReloaded = true;
      } else if (kind === 'navigate') {
        conn.pendingTakeover = false;
      }
    }
    return await Promise.race([run(conn.page, { takeoverReloaded, ...(originLease ? { originLease } : {}) }), interrupted]);
  } catch (err) {
    if (conn && isConnectionLoss(err)) {
      invalidate(conn);
      // The connection dying mid-action means the page was closed out from under
      // the tool — the user closed the browser tab, or the conversation was torn
      // down. The raw "CDP connection is not open" says neither what happened nor
      // what to do; say both. No automatic retry: a close is the user's call.
      throw new Error(
        `The browser page was closed while ${label} was running. The next browser action starts over from a fresh blank page.`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (onAbort) opts?.abort?.removeEventListener('abort', onAbort);
    originLease?.release();
    untrackInFlight(sessionId, revoke);
  }
}

/**
 * The session was deleted or archived: drop its browser connection and have the
 * desktop destroy its view outright. A session that never attached, or a
 * non-existent id, no-ops at every step.
 */
export async function releaseBrowserSession(sessionId: string): Promise<void> {
  // Bump first: an acquire still in flight for this conversation unwinds itself
  // when it sees the new epoch (see acquire) — it cannot be awaited here because
  // it may not have registered in pendingAcquires yet, and a hung endpoint
  // resolution must not block the session's deletion.
  releaseEpochs.set(sessionId, (releaseEpochs.get(sessionId) ?? 0) + 1);
  const conn = bySession.get(sessionId);
  if (conn) {
    bySession.delete(sessionId);
    conn.closed = true;
    await conn.bridge.close().catch(() => {});
  }
  // Dispose unconditionally, not just when a connection exists: a conversation
  // the user browsed by hand has a live view but never had a CDP connection, and
  // its view must still die with the session. disposeSession implies the bridge
  // detach that releaseSession would have done.
  if (browserAutomationAvailable()) {
    await browserViewHost()
      .disposeSession(sessionId)
      .catch(() => {});
  }
}

export { browserAutomationAvailable };

/** Test seam: reset module state between tests. */
export function resetBrowserSessionsForTest(): void {
  for (const conn of bySession.values()) {
    conn.closed = true;
    void conn.bridge.close().catch(() => {});
  }
  bySession.clear();
  pendingAcquires.clear();
  releaseEpochs.clear();
  inFlightBySession.clear();
}
