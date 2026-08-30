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

import { spawn } from 'node:child_process';

/**
 * Nightly trial switch for the fullscreen (alternate-screen) TUI, issue #4136.
 *
 * The fullscreen path swaps `TuiMainScreen` for `TuiAltScreen`: the composer
 * and status line stay anchored to the bottom of the screen while the
 * transcript scrolls in an application-owned viewport. This is a scoped
 * product experiment, not a stable mode: it defaults on only for nightly
 * builds and must not grow a permanent user-facing toggle until the nightly
 * evidence is in (issue non-goals).
 *
 * Precedence, highest first:
 *  1. `setting` — an explicit caller decision (`MakaPiTuiInput.tuiFullscreen`),
 *     used by embeddings and tests.
 *  2. `override` — the `MAKA_TUI_FULLSCREEN` environment variable. `1`/`true`
 *     opts a release build in; `0`/`false` opts a nightly build out.
 *  3. `packageVersion` — nightly default: on for `-dev.` versions (the
 *     Product Nightly identity in scripts/product-nightly.mjs), off otherwise.
 */
export const TUI_FULLSCREEN_ENV = 'MAKA_TUI_FULLSCREEN';

export interface TuiFullscreenResolution {
  readonly setting?: boolean;
  readonly override?: string;
  readonly packageVersion?: string;
}

export function isNightlyPackageVersion(version: string | undefined): boolean {
  if (!version) return false;
  // Product Nightly versions look like `0.2.0-dev.<runNumber>.<YYYYMMDD>`;
  // formal releases are always a stable product version.
  return /-dev\.[1-9]\d*\.\d{8}$/u.test(version);
}

export function resolveTuiFullscreen(resolution: TuiFullscreenResolution = {}): boolean {
  if (typeof resolution.setting === 'boolean') return resolution.setting;
  const override = resolution.override?.trim().toLowerCase();
  if (override === '1' || override === 'true') return true;
  if (override === '0' || override === 'false') return false;
  return isNightlyPackageVersion(resolution.packageVersion);
}

/**
 * Per-frame snapshot of the transcript scroll viewport. The chrome reads it
 * once per render to drive the unread indicator; the document line count comes
 * from the transcript document wrapper that renders inside the scroll view.
 */
export interface TranscriptWindowSnapshot {
  /** True while the scroll view is pinned to the newest content. */
  readonly followingEnd: boolean;
  /** Total rendered transcript document lines this frame. */
  readonly documentLines: number;
}

/**
 * Bridges the scroll view (which sees fresh scroll state at each frame's
 * layout pass) and the anchored chrome (which the layout engine measures
 * before the scroll view is laid out, so its view of scroll state lags one
 * frame). The scroll view computes the unread count and compares it against
 * what the chrome actually rendered, requesting one catch-up frame after any
 * change so the indicator settles deterministically.
 */
export interface UnreadOutputFeed {
  /** Lines appended since the user left the bottom, as of the latest layout. */
  readonly current: () => number;
  /** Called by the chrome each frame with the count it rendered. */
  readonly present: (unreadLines: number) => void;
}

/**
 * Counts transcript lines appended while the user is scrolled away from the
 * bottom — the "unread / new output" signal for the anchored-composer trial.
 *
 * Updated once per frame with the current window snapshot: growth accumulates
 * while the user is away, arriving at the bottom clears the count. Shrinks
 * (collapsing tool output, re-wraps) never manufacture unread lines; the
 * counter is approximate by design — it is an attention hint, not an exact
 * diff.
 */
export class UnreadOutputCounter {
  private lastDocumentLines: number | undefined;
  private unreadLines = 0;

  update(window: TranscriptWindowSnapshot): number {
    if (
      !window.followingEnd &&
      this.lastDocumentLines !== undefined &&
      window.documentLines > this.lastDocumentLines
    ) {
      this.unreadLines += window.documentLines - this.lastDocumentLines;
    }
    if (window.followingEnd) this.unreadLines = 0;
    this.lastDocumentLines = window.documentLines;
    return this.unreadLines;
  }

  /** Discards the accumulated count (e.g. after the user jumps to the bottom). */
  reset(): void {
    this.unreadLines = 0;
    this.lastDocumentLines = undefined;
  }
}

/** The rendered unread line: accent-colored, one row, empty when nothing is new. */
export function renderUnreadIndicator(
  unreadLines: number,
  accent: (text: string) => string,
): string[] {
  if (unreadLines <= 0) return [];
  const noun = unreadLines === 1 ? 'line' : 'lines';
  return [accent(`↓ ${unreadLines} new ${noun} — End to jump to latest`)];
}

/**
 * URL schemes a model-authored OSC 8 link may be opened with, mirroring the
 * desktop's external-link guard (apps/desktop/src/main/external-link-guard.ts):
 * web and mail only. Assistant Markdown is rendered with the raw href, so
 * everything else — `file:`, `javascript:`, unknown handlers, UNC paths —
 * must never reach an OS opener from a click.
 */
const OPENABLE_URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

export function isOpenableExternalUrl(url: string): boolean {
  try {
    return OPENABLE_URL_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * Opens an OSC 8 hyperlink activated by a primary-button click in the
 * fullscreen viewport. Model-authored hrefs are untrusted input, so the
 * opener is deliberately narrow:
 *
 * - Only `http:`, `https:`, and `mailto:` targets are handed off at all.
 * - Windows never routes the URL through cmd.exe — `spawn`'s argument
 *   quoting does not escape shell metacharacters (`&` would start a second
 *   command under `cmd /c start`), so the opener is `rundll32
 *   url.dll,FileProtocolHandler`, which receives the URL as a single argv
 *   element and hands it to ShellExecute. The DLL/entrypoint half of the
 *   command line is a compile-time constant, so a hostile URL cannot
 *   redirect it.
 * - macOS/Linux openers take the URL as a plain argv element (no shell).
 *
 * Failures are swallowed — a dead link must never take the TUI down.
 */
export function openExternalUrl(
  url: string,
  platform: NodeJS.Platform = process.platform,
  spawnProcess: typeof spawn = spawn,
): void {
  if (!isOpenableExternalUrl(url)) return;
  try {
    if (platform === 'darwin') {
      spawnProcess('open', [url], { detached: true, stdio: 'ignore' }).unref();
      return;
    }
    if (platform === 'win32') {
      spawnProcess('rundll32', ['url.dll,FileProtocolHandler', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
      return;
    }
    spawnProcess('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Best-effort only; the terminal may also offer its own link handling.
  }
}
