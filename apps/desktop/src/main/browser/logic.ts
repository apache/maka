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
 * Pure embedded-browser logic — no electron import, so every rule here is pinned
 * by plain unit tests. The electron-bound view lives in controller.ts.
 */

import { normalizeBrowserAddressInput, type BrowserState, type BrowserViewRect } from '@maka/core/browser';

export type { BrowserState, BrowserViewRect };

/**
 * Validate an address before loading it into the embedded view. Only http/https
 * are navigable: file://, javascript:, and other schemes are rejected so a typed
 * address or an in-page link can never reach the local filesystem or privileged
 * surfaces. Returns the parsed (normalized) URL string, or null if not allowed.
 */
export function parseNavigable(input: string): string | null {
  const result = normalizeBrowserAddressInput(input);
  return result.ok ? result.url : null;
}

// Page-provided non-web links are handed to the OS only for this tight set of
// schemes. Everything else (file:, javascript:, custom app protocols) is dropped
// so a hostile page can't launch local files or arbitrary registered handlers.
const EXTERNAL_SCHEMES = new Set(['mailto:', 'tel:']);

/**
 * The page-provided URL to hand to the system handler, or null to drop it. Only
 * a small allow-list of safe schemes escapes; navigable http/https links are
 * handled in-place by parseNavigable and never reach here.
 */
export function safeExternalUrl(url: string): string | null {
  const scheme = url.slice(0, url.indexOf(':') + 1).toLowerCase();
  return EXTERNAL_SCHEMES.has(scheme) ? url : null;
}

/**
 * Clamp a renderer-reported rect to integer, non-negative bounds (setBounds
 * rejects negatives). Returns null when there is no room to show the view (a
 * collapsed/empty strip — modal open, panel unmounted, mid-collapse) so the
 * caller hides it rather than painting a sliver.
 */
export function viewportBounds(rect: BrowserViewRect | null): BrowserViewRect | null {
  if (!rect) return null;
  // The rect crosses an untyped IPC boundary; a NaN/Infinity/non-number would
  // otherwise flow into setBounds and crash or wedge the native view. Reject the
  // whole rect (hide) unless every field is a finite number.
  if (![rect.x, rect.y, rect.width, rect.height].every((n) => Number.isFinite(n))) return null;
  const width = Math.max(0, Math.round(rect.width));
  const height = Math.max(0, Math.round(rect.height));
  if (width <= 0 || height <= 0) return null;
  // Clamp x/y non-negative too: a strip momentarily scrolled/laid out above the
  // content area can report a negative origin, and the comment's contract is a
  // fully non-negative rect.
  return { x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)), width, height };
}

/** What a browser action does to the page, for the visible-lease gate below. */
export type BrowserActionKind = 'observe' | 'mutate' | 'navigate';

/**
 * The visible-lease policy. The agent runs in a conversation's runtime, which may
 * NOT be the conversation on screen; without this gate it could drive a hidden,
 * zero-bounds view after the user switches away. EVERY action — including a
 * read (observe) — must happen in the conversation the user is looking at:
 * observing a logged-in page off screen would let a backgrounded conversation
 * exfiltrate its content the user can't see. `mutate` (click/type) additionally
 * needs real on-screen bounds, because opencli's native CDP click hit-tests a
 * composited frame a hidden view lacks; observe/navigate need only that the
 * session is shown (reading and goto don't require a painted frame).
 */
export function browserActionAllowed(
  kind: BrowserActionKind,
  view: { shown: boolean; hasViewport: boolean },
): boolean {
  if (!view.shown) return false;
  return kind === 'mutate' ? view.hasViewport : true;
}

export interface BrowserStateSnapshot {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

/**
 * Derive the renderer-facing state from a raw webContents snapshot. `hasPage` is
 * false until a real page is loaded (empty or about: URL), which keeps the DOM
 * empty state visible and the native overlay hidden; `secure` reflects https.
 */
export function deriveBrowserState(snapshot: BrowserStateSnapshot): BrowserState {
  return {
    url: snapshot.url,
    title: snapshot.title,
    canGoBack: snapshot.canGoBack,
    canGoForward: snapshot.canGoForward,
    loading: snapshot.loading,
    secure: /^https:\/\//i.test(snapshot.url),
    hasPage: snapshot.url !== '' && !snapshot.url.startsWith('about:'),
  };
}
