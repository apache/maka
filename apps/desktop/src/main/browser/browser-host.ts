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

/**
 * Injection seam between the browser tools / BrowserSession (pure logic, no
 * Electron) and the desktop view controller that owns each conversation's
 * WebContentsView and its sealed CDP bridge. The controller calls
 * provideBrowserViewHost() once it is ready (P3); until then the tools report
 * the browser as unavailable.
 *
 * The endpoint and its secret are handed back as same-process values and never
 * cross renderer IPC or preload (cdp-bridge.ts security rule 7). Unlike
 * PawWork's cross-package IoC, the tools, session, and controller all live in
 * this one package, so this is a plain module-level provider — no structural
 * error normalization is needed (the controller throws CdpBridgeError directly).
 */

import type { BrowserActionKind } from './logic.js';

export interface BrowserViewHost {
  /**
   * The visible-lease gate (see browserActionAllowed): may `sessionId` run a
   * `kind` action right now? EVERY kind — read, navigate, mutate — requires the
   * session to be the one the user is currently looking at (mutate also a real
   * viewport), so the agent can never drive OR read a hidden view after a
   * conversation switch. Checked before resolveEndpoint so a blocked action
   * creates no view.
   *
   * Resolves async for one case: a mutate on the conversation that IS on screen
   * but whose viewport is momentarily absent because a permission modal just
   * closed (the modal hid the native view) and the renderer has not re-reported
   * the strip yet. There it waits briefly for the restore so the first approved
   * click/type lands without a retry. `signal` cancels that wait.
   */
  canDrive(sessionId: string, kind: BrowserActionKind, opts?: { signal?: AbortSignal }): boolean | Promise<boolean>;
  /**
   * Resolve (lazily starting) the CDP endpoint for `sessionId`'s OWN view. The
   * view is the session's own, but it may be hidden — canDrive gates whether an
   * action may reach it. Throws a `code`-carrying error on failure (CdpBridgeError:
   * target-busy / target-destroyed / bridge-start-timeout).
   */
  resolveEndpoint(sessionId: string): Promise<{ cdpEndpoint: string }>;
  /**
   * Detach the CDP bridge attached on behalf of `sessionId` (connection lost,
   * timed out, aborted); the view itself lives on. A no-op when nothing attached.
   */
  releaseSession(sessionId: string): Promise<void>;
  /**
   * The conversation is gone (deleted or archived): destroy its view outright —
   * page, history, automation. A no-op for sessions that never had a view.
   */
  disposeSession(sessionId: string): Promise<void>;
}

let current: BrowserViewHost | null = null;

/** Called once by the desktop main process after the view controller is ready (P3). */
export function provideBrowserViewHost(host: BrowserViewHost | null): void {
  current = host;
}

export function browserAutomationAvailable(): boolean {
  return current !== null;
}

export function browserViewHost(): BrowserViewHost {
  if (!current) throw new Error('Browser automation is only available inside the desktop app.');
  return current;
}
