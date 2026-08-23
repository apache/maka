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
 * Embedded-browser tuning constants. Ported from PawWork's browser/options.ts.
 */

import type { WebPreferences } from 'electron';

/**
 * Single app-owned persistent partition: one browsing session shared by every
 * conversation, surviving restarts. `persist:` keeps cookies/storage on disk so
 * a login done in one conversation is available to all. Each conversation still
 * has its OWN view/page/nav state.
 */
export const BROWSER_PARTITION = 'persist:maka-browser';

/**
 * WebPreferences for an embedded-browser WebContentsView. It loads arbitrary
 * external sites the agent drives, so it is locked down and deliberately
 * distinct from the app renderer: NO preload — the page must never receive the
 * app's IPC bridge — plus sandbox, context isolation, no Node, web security on.
 */
export function browserViewWebPreferences(): WebPreferences {
  return {
    partition: BROWSER_PARTITION,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
  };
}

/**
 * CDP automation bridge tuning. The secret is a high-entropy token carried in
 * the ws path and kept in main-process memory only; the start timeout bounds how
 * long we wait for the bridge's ws server to come up (debugger attach itself is
 * synchronous) before surfacing a typed error instead of hanging.
 */
export const CDP_BRIDGE_SECRET_LENGTH = 32;
export const BRIDGE_START_TIMEOUT_MS = 5_000;
