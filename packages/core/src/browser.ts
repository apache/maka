/**
 * Shared embedded-browser types crossing the main ↔ preload ↔ renderer
 * boundary (window.maka.browser). The main-process logic that derives these
 * lives in apps/desktop/src/main/browser/logic.ts.
 */

/** Renderer-facing snapshot of one conversation's embedded browser. */
export interface BrowserState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  /** https origin. */
  secure: boolean;
  /** A real page is loaded (not blank / about:) — gates the DOM empty state. */
  hasPage: boolean;
}

/** Where the embedded view sits, in renderer CSS px (1:1 with the window's content DIP). */
export interface BrowserViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BrowserAddressInputFailureReason = 'empty' | 'unsupported_scheme' | 'invalid_url';

export type BrowserAddressInputResult =
  | { ok: true; url: string }
  | { ok: false; reason: BrowserAddressInputFailureReason };

/**
 * Normalize a user-entered browser address before it crosses the IPC boundary.
 * Bare hostnames are treated as HTTPS, while explicit non-web schemes are
 * rejected with a visible reason for the renderer.
 */
export function normalizeBrowserAddressInput(input: string): BrowserAddressInputResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };

  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported_scheme' };
  }

  return { ok: true, url: url.toString() };
}
