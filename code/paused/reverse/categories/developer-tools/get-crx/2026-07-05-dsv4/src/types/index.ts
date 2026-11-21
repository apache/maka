/**
 * Get CRX — TypeScript type definitions
 * Reverse-engineered from bg.js (MV3 service worker)
 * Original version: 1.51
 */

// ============================================================
// Chrome Web Store page URL parsing
// ============================================================

/**
 * Identifies which generation of the Chrome Web Store the user is browsing.
 * - "classic": chrome.google.com/webstore/detail/*
 * - "new": chromewebstore.google.com/detail/*
 */
export type WebStoreVariant = "classic" | "new";

/**
 * Result of parsing a Chrome Web Store tab URL.
 */
export interface WebStoreTabInfo {
  /** Which webstore variant was detected */
  variant: WebStoreVariant;
  /** The extension ID extracted from the URL */
  extensionId: string;
  /** The human-readable extension name extracted from the page title */
  extensionName: string;
}

// ============================================================
// CRX download URL construction
// ============================================================

/**
 * Parameters used to construct the Google CRX update API download URL.
 */
export interface CrxDownloadParams {
  /** Chrome's NaCl architecture string (e.g. "x86-64", "arm") */
  naclArch: string;
  /** Chrome product version string (e.g. "126.0.6478.126") */
  prodVersion: string;
  /** The Chrome Web Store extension ID */
  extensionId: string;
  /**
   * Accepted CRX format specifier.
   * "crx2,crx3" requests both v2 and v3 formats.
   */
  acceptFormat: string;
}

/**
 * The base URL template for the Google CRX update API.
 * Format: https://clients2.google.com/service/update2/crx?response=redirect&nacl_arch={arch}&prodversion={ver}&acceptformat={fmt}&x=id%3D{id}%26installsource%3Dondemand%26uc
 */
export const CRX_UPDATE_API_BASE =
  "https://clients2.google.com/service/update2/crx";

// ============================================================
// Extension state
// ============================================================

/**
 * Global mutable state shared between the context menu handler
 * and the download filename suggester.
 *
 * WARNING: Not thread-safe. If two downloads are initiated before
 * the first completes, the second will overwrite the first's name.
 */
export interface GlobalState {
  /** The sanitized extension name for the pending download */
  extName: string | undefined;
}

// ============================================================
// Context menu configuration
// ============================================================

export const CONTEXT_MENU_ID = "getCRX";

export const CONTEXT_MENU_CONFIG = {
  id: CONTEXT_MENU_ID,
  title: "Get CRX of this extension",
  contexts: ["all"] as chrome.contextMenus.ContextType[],
  documentUrlPatterns: [
    "https://chrome.google.com/webstore/detail/*",
    "https://chromewebstore.google.com/detail/*",
  ],
} as const;

// ============================================================
// Content script / message passing (reserved for future use)
// ============================================================

/**
 * Message types for potential content-script communication.
 * Currently unused — the extension operates purely via context menus.
 */
export type ExtensionMessage = {
  action: "downloadCrx";
  extensionId: string;
};
