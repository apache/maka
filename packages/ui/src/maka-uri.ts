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

import { SETTINGS_SECTIONS, type SettingsSection } from '@maka/core/settings';

const ALLOWED_SETTINGS_SECTIONS = new Set<SettingsSection>(SETTINGS_SECTIONS);
const RAW_HREF_MAX_LENGTH = 4096;
const COMPOSE_TEXT_MAX_LENGTH = 4096;
const FILE_REFERENCE_MAX_LENGTH = 2048;

/** Closed internal navigation surface; it never executes actions. */
export type MakaUriDest =
  | { kind: 'settings'; section: SettingsSection }
  | { kind: 'compose'; text: string }
  /** Raw workspace file reference exactly as written (never resolved here). */
  | { kind: 'file-ref'; reference: string };

/**
 * Parse an exact lowercase internal URI. Unsupported namespaces and malformed
 * inputs return null; callers must never pass them to external navigation.
 */
export function parseMakaUri(href: string): MakaUriDest | null {
  if (typeof href !== 'string') return null;
  if (href.length === 0 || href.length > RAW_HREF_MAX_LENGTH) return null;
  if (!href.startsWith('maka:')) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'maka:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.port !== '') return null;
  if (url.hash !== '') return null;

  switch (url.hostname) {
    case 'settings': {
      if (url.search !== '') return null;
      const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
      if (segments.length !== 1) return null;
      const section = segments[0]!;
      if (!isSettingsSection(section)) return null;
      return { kind: 'settings', section };
    }
    case 'compose': {
      if (url.pathname !== '' && url.pathname !== '/') return null;
      const text = url.searchParams.get('text');
      if (text === null || text.length === 0 || text.length > COMPOSE_TEXT_MAX_LENGTH) return null;
      return { kind: 'compose', text };
    }
    default:
      return null;
  }
}

/** Markdown file suffixes a transcript reference must carry to be actionable. */
const FILE_REFERENCE_SUFFIX = /\.(?:md|markdown)$/i;
/** Any URI scheme (`file:`, `http:`, `custom:`) disqualifies a raw file reference. */
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const PERCENT_ESCAPE = /%[0-9a-f]{2}/i;

/**
 * Recognize a workspace file reference in a Markdown link destination and
 * return it **raw** (exactly as written, no decoding, no resolution).
 *
 * Only relative or absolute filesystem paths ending in a Markdown suffix are
 * recognized; every URI scheme (including `file://`) stays out so the external
 * navigation guard remains the sole authority for those. Percent-escapes are
 * decoded for recognition only — spaces, CJK, and other non-ASCII references
 * must resolve identically to their percent-encoded spellings. The consumer
 * decides whether a handler exists; callers must treat `null` as "leave the
 * link inert".
 */
export function parseFileReference(href: string): string | null {
  if (typeof href !== 'string') return null;
  if (href.length === 0 || href.length > FILE_REFERENCE_MAX_LENGTH) return null;
  if (URI_SCHEME.test(href)) return null;
  if (/[\u0000-\u001f\u007f]/.test(href)) return null;

  let candidate = href;
  if (PERCENT_ESCAPE.test(candidate)) {
    try {
      candidate = decodeURIComponent(candidate);
    } catch {
      // Malformed escapes stay raw; the suffix check below still applies.
    }
  }
  if (!FILE_REFERENCE_SUFFIX.test(candidate)) return null;
  return href;
}

/**
 * Case-insensitive probe used to keep internal-looking links out of the
 * external navigation path. Parsing remains lowercase-only.
 */
export function isMakaUriCandidate(href: string): boolean {
  return typeof href === 'string' && /^maka:/i.test(href);
}

/** External links are restricted to browser and mail destinations. */
export function isSafeExternalScheme(href: string): boolean {
  if (typeof href !== 'string') return false;
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:';
}

function isSettingsSection(value: string): value is SettingsSection {
  return ALLOWED_SETTINGS_SECTIONS.has(value as SettingsSection);
}
