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

// apps/desktop/src/main/mcp-oauth-controller.ts
//
// Interactive OAuth for remote MCP servers: the RFC 8252 native-app shape.
// login() binds a loopback callback listener, asks the manager for the
// authorization URL, opens it in the system browser (never an embedded
// webview — the user must be able to see the address bar), waits for the
// redirect, and hands the code back to the manager for the token exchange.
//
// The listener binds 127.0.0.1 on an ephemeral port by default. A server
// whose OAuth client was registered statically pins `oauth.callbackPort`
// in its config, because its registered redirect URI carries a fixed port.

import { randomBytes } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { isLoopbackHost, type McpServerStatus } from '@maka/core/mcp';
import type { McpAuthorizationStart } from '@maka/mcp';

const CALLBACK_PATH = '/callback';
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;
/** The terminal-cleanup wait is guarding against a wedged credential lane,
 * not doing real work — a few seconds is enough; a round that already
 * timed out must not hold its caller for a second full round. */
const ABANDON_GRACE_MS = 5_000;

export interface McpOAuthLoginManager {
  startAuthorization(
    serverId: string,
    redirectUrl: string,
    options?: { state?: string; signal?: AbortSignal },
  ): Promise<McpAuthorizationStart>;
  finishAuthorization(
    serverId: string,
    callback: { code: string; iss?: string; state?: string },
    options?: { signal?: AbortSignal },
  ): Promise<McpServerStatus>;
  clearAuthorization(
    serverId: string,
    options?: { signal?: AbortSignal },
  ): Promise<McpServerStatus>;
  /** Clears a persisted-but-dead pending round (verifier/redirect/state),
   * keeping tokens and client registration intact. */
  abandonAuthorization(serverId: string): Promise<void>;
  pendingAuthorization(
    serverId: string,
  ): Promise<{ redirectUrl: string; state?: string } | undefined>;
  status(serverId: string): McpServerStatus | undefined;
}

export interface McpOAuthControllerDeps {
  manager: McpOAuthLoginManager;
  openExternal(url: string): Promise<void>;
  /** Awaited (under the round deadline) before login and before a resumed
   * round's token exchange: the listener rebinds from storage alone (early,
   * independent of connects), but the manager needs the server config. */
  ensureReady?(): Promise<void>;
  /** Resolves the configured static callback port for a server. Owned by
   * the controller so the store read rides the SAME round deadline — an
   * IPC-side preflight await would sit outside it and park the renderer's
   * login lock forever if the store hung. */
  callbackPort?(serverId: string): Promise<number | undefined>;
  /** The IPC layer's config-mutation lane (createMcpExclusiveLane). The
   * login/resume CLAIM travels through it, so a claim can never land
   * between a config transaction's active-login check and its write — and
   * a claim never lands while a transaction is mid-flight. The round itself
   * runs outside the lane; only the claim is serialized. */
  claimLane?: <T>(work: () => Promise<T>) => Promise<T>;
  loginTimeoutMs?: number;
  copy?: { successTitle: string; successBody: string; failureTitle: string };
}

export interface McpOAuthController {
  login(serverId: string): Promise<McpServerStatus>;
  logout(serverId: string): Promise<McpServerStatus>;
  /** Whether a login round currently owns this server. The IPC layer
   * refuses config mutation for a server mid-round: renderer-side locks are
   * advisory, and a config change under a live browser round would race the
   * callback against a changed or absent server. */
  isActive(serverId: string): boolean;
  /** Ends an in-flight round the way a timeout would: the race rejects,
   * the signal fences the round's late writes, the guard releases, and the
   * terminal cleanup clears the persisted pending state — so the ordinary
   * "clicked Login, closed the tab" path is not a five-minute trap in
   * which every config edit for the server is vetoed. Returns false when
   * no round is active. */
  cancelLogin(serverId: string): boolean;
  /** Rebinds the loopback listener for a login round the manager persisted
   * before an app restart, so the browser's callback still lands. Resolves
   * undefined when there is nothing to resume (or the port is taken). */
  resumeLogin(serverId: string): Promise<McpServerStatus | undefined>;
}

export function createMcpOAuthController(deps: McpOAuthControllerDeps): McpOAuthController {
  const active = new Set<string>();
  const roundAborts = new Map<string, (reason: Error) => void>();
  const timeoutMs = deps.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const claimLane = deps.claimLane ?? (async <T,>(work: () => Promise<T>) => work());
  /** Claims the per-server round guard through the shared config-mutation
   * lane (when wired): after this resolves, every config transaction sees
   * `isActive()` true, and no transaction was mid-flight when it landed. */
  const claim = (serverId: string): Promise<boolean> =>
    claimLane(async () => {
      if (active.has(serverId)) return false;
      active.add(serverId);
      return true;
    });
  /** Terminal-failure cleanup is BOUNDED: the abandon frequently shares the
   * exact resource that stalled the round (a wedged credential lane), and
   * awaiting it unbounded would park the rejection — and the renderer's
   * lock — forever. A late abandon completing afterwards is harmless: it is
   * version-pinned against newer rounds. */
  const abandonGraceMs = Math.min(timeoutMs, ABANDON_GRACE_MS);
  const boundedAbandon = (serverId: string): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, abandonGraceMs);
      timer.unref?.();
      void deps.manager
        .abandonAuthorization(serverId)
        .catch(() => {})
        .finally(() => {
          clearTimeout(timer);
          resolve();
        });
    });
  const copy = deps.copy ?? {
    successTitle: 'Login complete',
    successBody: 'You can close this tab and return to Maka.',
    failureTitle: 'Login failed',
  };

  async function login(serverId: string): Promise<McpServerStatus> {
    if (!(await claim(serverId))) {
      throw new Error(`MCP login already in progress: ${serverId}`);
    }
    let deadlineRef: { abort(reason: Error): void } | undefined;
    roundAborts.set(serverId, (reason) => deadlineRef?.abort(reason));
    // One deadline for the whole round — discovery, browser wait, and token
    // exchange. A metadata or token endpoint that accepts the connection and
    // never answers must not hold the in-progress guard and the loopback
    // listener forever.
    const deadline = createLoginDeadline(timeoutMs);
    deadlineRef = deadline;
    try {
      // Preflight rides the same deadline: a hung readiness gate or a
      // wedged credential/config store must release the round like any
      // other stalled stage, not hold the guard forever.
      await deadline.race(Promise.resolve(deps.ensureReady?.()));
      const callbackPort = deps.callbackPort
        ? await deadline.race(deps.callbackPort(serverId))
        : undefined;
      const state = randomBytes(16).toString('hex');
      const callback = await startCallbackListener({
        port: callbackPort,
        state,
        copy,
      });
      try {
        const start = await deadline.race(
          deps.manager.startAuthorization(serverId, callback.redirectUrl, {
            state,
            signal: deadline.signal,
          }),
        );
        if (start.status === 'authorized') {
          // Stored or refreshed credentials already satisfied the server —
          // no browser round needed.
          return requireStatus(deps.manager, serverId);
        }
        // Deliberate defence-in-depth: McpClientManager already refused
        // anything this check would (its assertTransportSecurity is
        // strictly stronger), so against the real manager this cannot fire.
        // It stays for any future McpOAuthLoginManager implementer — the
        // controller hands this URL to shell.openExternal and must not
        // trust the interface contract alone with file:, javascript: or a
        // custom app protocol.
        // A cleartext authorization URL off the machine would also hand the
        // whole login (and the code coming back) to the network, so http is
        // loopback-only — the same rule the config store applies to
        // endpoint URLs.
        const authorizationUrl = new URL(start.authorizationUrl);
        const isSecure =
          authorizationUrl.protocol === 'https:' ||
          (authorizationUrl.protocol === 'http:' && isLoopbackHost(authorizationUrl.hostname));
        if (!isSecure) {
          throw new Error(
            `Authorization URL for MCP server "${serverId}" refused: non-loopback URLs require https`,
          );
        }
        // TODO(disclosure): before this opens, the confirm step in the UI
        // (#2921) should show `start.issuer` and `start.scopes` — the host,
        // path, scope and resource of this URL are all chosen by the
        // untrusted MCP server, and the system browser's address bar is
        // currently the only disclosure the user gets.
        // The shell launch rides the same deadline: a hung `openExternal`
        // must not hold the listener and the active guard past it.
        await deadline.race(deps.openExternal(authorizationUrl.toString()));
        const payload = await deadline.race(callback.authorizationCode);
        return await deadline.race(
          deps.manager.finishAuthorization(
            serverId,
            { ...payload, state },
            { signal: deadline.signal },
          ),
        );
      } finally {
        // Timeout included: the port is released on every exit.
        callback.close();
      }
    } catch (error) {
      // The round is terminally dead — denied, timed out, or the browser
      // never opened. Its persisted verifier/redirect/state must go with
      // it: otherwise the boot resume rebinds a listener for a round that
      // can never complete and occupies the login guard on every restart.
      await boundedAbandon(serverId);
      throw error;
    } finally {
      deadline.cancel();
      roundAborts.delete(serverId);
      active.delete(serverId);
    }
  }

  async function resumeLogin(serverId: string): Promise<McpServerStatus | undefined> {
    // Claim the guard before the first await: checking, awaiting, and only
    // then claiming would let a concurrent login() start a second round —
    // and either round's cleanup would release the other's guard.
    if (!(await claim(serverId))) return undefined;
    const deadline = createLoginDeadline(timeoutMs);
    roundAborts.set(serverId, (reason) => deadline.abort(reason));
    try {
      // The pending lookup reads the credential store, which can wait on a
      // contended file lock — the guard must not outlive the deadline here
      // either.
      const pending = await deadline.race(deps.manager.pendingAuthorization(serverId));
      // Without the persisted state the callback cannot be verified; without
      // a fixed port the browser's redirect target is gone. Either way the
      // round is unresumable — the user simply logs in again.
      if (!pending?.state) return undefined;
      const redirectUrl = new URL(pending.redirectUrl);
      const port = Number(redirectUrl.port);
      if (redirectUrl.hostname !== '127.0.0.1' || !Number.isInteger(port) || port === 0) {
        return undefined;
      }
      let callback: Awaited<ReturnType<typeof startCallbackListener>>;
      try {
        callback = await startCallbackListener({
          port,
          state: pending.state,
          copy,
        });
      } catch {
        // The recorded port is taken (or cannot be bound) — the round is
        // unresumable, which the contract reports as undefined, not as a
        // failure: the user simply logs in again.
        return undefined;
      }
      try {
        const payload = await deadline.race(callback.authorizationCode);
        await deadline.race(Promise.resolve(deps.ensureReady?.()));
        return await deadline.race(
          deps.manager.finishAuthorization(
            serverId,
            { ...payload, state: pending.state },
            { signal: deadline.signal },
          ),
        );
      } catch (error) {
        // Same terminality as login(): a resumed round that denied or
        // timed out is dead — clear it rather than resume it again on the
        // next restart.
        await boundedAbandon(serverId);
        throw error;
      } finally {
        callback.close();
      }
    } finally {
      deadline.cancel();
      roundAborts.delete(serverId);
      active.delete(serverId);
    }
  }

  return {
    login,
    async logout(serverId) {
      // Same bounded-round rule as login: readiness and the credential
      // clear run under one deadline, so a stalled store or a hung
      // reconnect cannot park the renderer's logout lock forever.
      const deadline = createLoginDeadline(timeoutMs);
      try {
        await deadline.race(Promise.resolve(deps.ensureReady?.()));
        // The signal travels INTO the erase: racing alone would abandon the
        // caller while the stalled clear kept running and could tombstone
        // the fresh tokens a NEWER login stores in the meantime.
        return await deadline.race(
          deps.manager.clearAuthorization(serverId, { signal: deadline.signal }),
        );
      } finally {
        deadline.cancel();
      }
    },
    resumeLogin,
    cancelLogin(serverId) {
      const abort = roundAborts.get(serverId);
      if (!abort) return false;
      abort(new Error('Login cancelled'));
      return true;
    },
    isActive: (serverId) => active.has(serverId),
  };
}

/** What the loopback listener hands back after verifying the state: the
 * full protocol payload the SDK still needs to validate — the code AND the
 * RFC 9207 `iss` parameter. Truncating to a bare code here would silently
 * disable the SDK's authorization-server mix-up defense. */
export interface McpAuthorizationCallbackPayload {
  code: string;
  iss?: string;
}

interface CallbackListener {
  redirectUrl: string;
  authorizationCode: Promise<McpAuthorizationCallbackPayload>;
  close(): void;
}

/** One deadline covering a complete login round. Callers race every stage
 * against it — discovery/probe, the browser wait, and the token exchange —
 * so a hung remote endpoint cannot park the round past the timeout. The
 * deadline's `signal` travels INTO the round: racing alone would only
 * abandon the caller while the underlying OAuth flow kept running and could
 * write verifier/state/tokens after a second login started — the signal
 * aborts its requests and fences its late storage writes. */
function createLoginDeadline(timeoutMs: number): {
  race<T>(operation: Promise<T>): Promise<T>;
  signal: AbortSignal;
  cancel(): void;
  abort(reason: Error): void;
} {
  const round = new AbortController();
  let cancel!: () => void;
  let abort!: (reason: Error) => void;
  const expired = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      round.abort(new Error('Timed out waiting for the browser login'));
      reject(new Error('Timed out waiting for the browser login'));
    }, timeoutMs);
    timer.unref();
    cancel = () => clearTimeout(timer);
    // A user cancellation ends the round the same way a timeout does: the
    // race rejects and the signal fences the round's late writes.
    abort = (reason: Error) => {
      clearTimeout(timer);
      round.abort(reason);
      reject(reason);
    };
  });
  // Nothing may be racing when the deadline fires (or after cancel) — the
  // rejection must not crash the process as unhandled.
  expired.catch(() => {});
  return {
    race: <T>(operation: Promise<T>) => Promise.race([operation, expired]),
    signal: round.signal,
    cancel,
    abort,
  };
}

function startCallbackListener(input: {
  port?: number;
  state: string;
  copy: { successTitle: string; successBody: string; failureTitle: string };
}): Promise<CallbackListener> {
  return new Promise((resolveListener, rejectListener) => {
    let settleCode!: (payload: McpAuthorizationCallbackPayload) => void;
    let failCode!: (error: Error) => void;
    const authorizationCode = new Promise<McpAuthorizationCallbackPayload>((resolve, reject) => {
      settleCode = resolve;
      failCode = reject;
    });
    // The 'authorized' short-circuit never awaits this promise, and close()
    // rejects it — mark it handled so that path can't crash the process.
    authorizationCode.catch(() => {});

    let expectedHost: string | undefined;
    const server: Server = createServer((request, response) => {
      // Same rules as this repo's other loopback listener (cdp-bridge):
      // the Host must be the loopback authority this listener bound — a
      // DNS-rebinding page cannot present it — and a request carrying a
      // browser Origin is a cross-origin fetch, not the redirect
      // navigation this endpoint exists for.
      if (expectedHost !== undefined && request.headers.host !== expectedHost) {
        response.writeHead(403).end();
        return;
      }
      if (request.headers.origin !== undefined) {
        response.writeHead(403).end();
        return;
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== CALLBACK_PATH) {
        response.writeHead(404).end();
        return;
      }
      // State first: only a callback that proves it belongs to this login
      // round may affect it. Handling `error` before the state check would
      // let anyone on loopback abort a real login with a forged
      // access_denied.
      const returnedState = url.searchParams.get('state');
      if (returnedState !== input.state) {
        respond(response, 400, input.copy.failureTitle, 'Invalid callback.');
        return;
      }
      const error = url.searchParams.get('error');
      if (error) {
        // Fixed local copy only: `error_description` is the authorization
        // server's arbitrary prose, and rendering it on a page the user
        // reads as Maka's is a phishing surface even HTML-escaped. The
        // sanitized code is the one server-controlled token shown.
        respond(response, 200, input.copy.failureTitle, sanitizeOAuthErrorCode(error));
        failCode(new Error(`Authorization failed: ${sanitizeOAuthErrorCode(error)}`));
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        respond(response, 400, input.copy.failureTitle, 'Invalid callback.');
        return;
      }
      respond(response, 200, input.copy.successTitle, input.copy.successBody);
      const iss = url.searchParams.get('iss');
      settleCode({ code, ...(iss !== null ? { iss } : {}) });
    });
    server.on('error', (error) => {
      rejectListener(error);
    });
    server.listen(input.port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        rejectListener(new Error('Callback listener has no address'));
        return;
      }
      expectedHost = `127.0.0.1:${address.port}`;
      resolveListener({
        redirectUrl: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
        authorizationCode,
        close: () => {
          failCode(new Error('Login cancelled'));
          server.close();
          // Callback responses have flushed by the time close() runs in the
          // login flow; lingering keep-alive sockets must not hold the port.
          server.closeAllConnections();
        },
      });
    });
  });
}

/** The registered OAuth error codes this flow can encounter (RFC 6749 §4.1.2.1
 * and §5.2, plus the OIDC interaction codes). A strict allowlist, not a shape
 * check: the parameter is attacker-writable, and anything that merely LOOKS
 * like a code (`opaqueSecret123`) must not tunnel through to the renderer. */
const OAUTH_ERROR_CODES = new Set([
  'invalid_request',
  'unauthorized_client',
  'access_denied',
  'unsupported_response_type',
  'invalid_scope',
  'server_error',
  'temporarily_unavailable',
  'invalid_client',
  'invalid_grant',
  'unsupported_grant_type',
  'interaction_required',
  'login_required',
  'consent_required',
]);

function sanitizeOAuthErrorCode(value: string): string {
  return OAUTH_ERROR_CODES.has(value) ? value : 'unknown_error';
}

function requireStatus(manager: McpOAuthLoginManager, serverId: string): McpServerStatus {
  const status = manager.status(serverId);
  if (!status) throw new Error(`Unknown MCP server: ${serverId}`);
  return status;
}

function respond(response: ServerResponse, statusCode: number, title: string, body: string): void {
  const html = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font-family:system-ui;display:grid;place-items:center;min-height:80vh"><div style="text-align:center"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></div></body>`;
  response
    .writeHead(statusCode, {
      'content-type': 'text/html; charset=utf-8',
      // The redirect URL carried the one-time code; the response must not
      // let the round-tripped page (and its URL) sit in a shared cache.
      'cache-control': 'no-store',
    })
    .end(html);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);
}
