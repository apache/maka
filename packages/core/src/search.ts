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

export const SEARCH_QUERY_MAX_CHARS = 500;
export const SEARCH_DOMAIN_MAX_CHARS = 253;
export const SEARCH_URL_MAX_CHARS = 4096;
export const SEARCH_DEFAULT_LIMIT = 5;
export const SEARCH_MAX_LIMIT = 10;

const TRACKING_PARAM_PREFIXES = ['utm_'];
const TRACKING_PARAM_NAMES = new Set(['fbclid', 'gclid', 'yclid', 'mc_cid', 'mc_eid']);

export type SearchSourceKind = 'web' | 'web_fetch' | 'thread' | 'memory' | 'activity' | 'tool';

export type SearchProviderKind = 'disabled' | 'api' | 'browser_scrape' | 'local';

export type SearchErrorReason =
  | 'disabled'
  | 'missing_provider'
  | 'missing_credentials'
  | 'invalid_query'
  | 'invalid_domain'
  | 'invalid_url'
  | 'blocked_scheme'
  | 'blocked_domain'
  | 'timeout'
  | 'aborted'
  | 'needs_human_browser'
  | 'provider_error'
  | 'parse_error'
  // Malformed privacy state fails closed to the same user-visible reason.
  | 'incognito_active';

export type SearchSourceSnapshot =
  | { kind: 'thread'; provider: 'local'; enabled: true }
  | { kind: 'memory'; provider: 'local' | 'api'; enabled: boolean; queryRewriteEnabled?: boolean }
  | { kind: 'activity'; provider: 'local'; enabled: boolean; permissionRequired: true }
  | { kind: 'tool'; provider: 'local' | 'api'; enabled: boolean }
  | { kind: 'web'; provider: SearchProviderKind; enabled: boolean; hasCredentials?: boolean }
  | {
      kind: 'web_fetch';
      provider: 'browser_scrape' | 'api';
      enabled: boolean;
      authenticatedBrowser?: boolean;
    };

export interface SearchRequest {
  source: SearchSourceKind;
  query: string;
  limit: number;
  allowedDomains?: string[];
  blockedDomains?: string[];
  includeMarkdown?: boolean;
  refresh?: boolean;
}

export interface WebFetchRequest {
  source: 'web_fetch';
  url: string;
  prompt?: string;
  maxBytes: number;
  refresh?: boolean;
}

/** Non-URL navigation target; web results continue to use `url`. */
export type SearchResultTarget = {
  kind: 'thread';
  sessionId: string;
  turnId?: string;
  sequence?: number;
};

export interface SearchResult {
  source: SearchSourceKind;
  citationIndex?: number;
  title: string;
  url?: string;
  /** Navigation target for source kinds that do not map to a URL. */
  target?: SearchResultTarget;
  snippet?: string;
  summary?: string;
  markdown?: string;
  fetchedAt?: string;
  cachedAt?: string;
  truncated?: boolean;
  wordCount?: number;
  errorReason?: SearchErrorReason;
}

export interface SearchError {
  ok: false;
  reason: SearchErrorReason;
  message: string;
}

export interface SearchOk<T> {
  ok: true;
  value: T;
}

export type SearchNormalizeResult<T> = SearchOk<T> | SearchError;

export function normalizeSearchQuery(input: unknown): SearchNormalizeResult<string> {
  if (typeof input !== 'string') {
    return invalid('invalid_query', 'Search query must be a string');
  }
  const value = input.trim();
  if (value.length === 0) {
    return invalid('invalid_query', 'Search query cannot be empty');
  }
  if (Array.from(value).length > SEARCH_QUERY_MAX_CHARS) {
    return invalid(
      'invalid_query',
      `Search query must be ${SEARCH_QUERY_MAX_CHARS} characters or fewer`,
    );
  }
  return { ok: true, value };
}

export function normalizeSearchLimit(
  input: unknown,
  options: { defaultValue?: number; max?: number } = {},
): SearchNormalizeResult<number> {
  const defaultValue = options.defaultValue ?? SEARCH_DEFAULT_LIMIT;
  const max = options.max ?? SEARCH_MAX_LIMIT;
  if (input === undefined || input === null || input === '') {
    return { ok: true, value: defaultValue };
  }
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    return invalid('invalid_query', 'Search limit must be a finite number');
  }
  const value = Math.trunc(input);
  if (value < 1) {
    return invalid('invalid_query', 'Search limit must be at least 1');
  }
  return { ok: true, value: Math.min(value, max) };
}

export function normalizeSearchDomain(input: unknown): SearchNormalizeResult<string> {
  if (typeof input !== 'string') {
    return invalid('invalid_domain', 'Search domain must be a string');
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return invalid('invalid_domain', 'Search domain cannot be empty');
  }
  if (trimmed.length > SEARCH_DOMAIN_MAX_CHARS) {
    return invalid(
      'invalid_domain',
      `Search domain must be ${SEARCH_DOMAIN_MAX_CHARS} characters or fewer`,
    );
  }
  try {
    const hostname = (
      trimmed.includes('://') ? new URL(trimmed) : new URL(`https://${trimmed}`)
    ).hostname
      .toLowerCase()
      .replace(/\.$/, '');
    if (!hostname || hostname.includes('..')) {
      return invalid('invalid_domain', 'Search domain is invalid');
    }
    return { ok: true, value: hostname.startsWith('www.') ? hostname.slice(4) : hostname };
  } catch {
    return invalid('invalid_domain', 'Search domain is invalid');
  }
}

export function normalizeSearchDomainList(input: unknown): SearchNormalizeResult<string[]> {
  if (input === undefined || input === null) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(input)) {
    return invalid('invalid_domain', 'Search domains must be an array');
  }
  const domains: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const result = normalizeSearchDomain(item);
    if (!result.ok) {
      return result;
    }
    if (!seen.has(result.value)) {
      seen.add(result.value);
      domains.push(result.value);
    }
  }
  return { ok: true, value: domains };
}

export function searchDomainMatches(hostname: string, domains: readonly string[]): boolean {
  const normalized = normalizeSearchDomain(hostname);
  if (!normalized.ok) {
    return false;
  }
  return domains.some(
    (domain) => normalized.value === domain || normalized.value.endsWith(`.${domain}`),
  );
}

export function normalizeSearchUrl(input: unknown): SearchNormalizeResult<string> {
  if (typeof input !== 'string') {
    return invalid('invalid_url', 'Search URL must be a string');
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return invalid('invalid_url', 'Search URL cannot be empty');
  }
  if (trimmed.length > SEARCH_URL_MAX_CHARS) {
    return invalid('invalid_url', `Search URL must be ${SEARCH_URL_MAX_CHARS} characters or fewer`);
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return invalid('invalid_url', 'Search URL is invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return invalid('blocked_scheme', 'Search URL must use http or https');
  }
  return { ok: true, value: stripSearchTrackingParams(url).toString() };
}

export function stripSearchTrackingParams(url: URL): URL {
  const next = new URL(url.toString());
  for (const key of Array.from(next.searchParams.keys())) {
    const lower = key.toLowerCase();
    if (
      TRACKING_PARAM_NAMES.has(lower) ||
      TRACKING_PARAM_PREFIXES.some((prefix) => lower.startsWith(prefix))
    ) {
      next.searchParams.delete(key);
    }
  }
  return next;
}

export function rewriteSearchQueryForFreshness(query: string, now: Date): string {
  const trimmed = query.trim();
  if (!hasFreshnessIntent(trimmed) || hasHistoricalIntent(trimmed)) {
    return trimmed;
  }
  const year = String(now.getFullYear());
  const yearPattern = /\b(?:19|20)\d{2}\b/g;
  const years: string[] = trimmed.match(yearPattern) ?? [];
  if (years.length === 0) {
    return `${trimmed} ${year}`;
  }
  if (years.includes(year)) {
    return trimmed;
  }
  return trimmed.replace(yearPattern, year);
}

function hasFreshnessIntent(query: string): boolean {
  return /\b(today|latest|this year|current year|now|recent|breaking)\b|今天|最新|今年|当前年份|最近|近日/i.test(
    query,
  );
}

function hasHistoricalIntent(query: string): boolean {
  return /\b(history|historical|archive|from|since|during|between|retrospective)\b|历史|回顾|档案|过去|往年/i.test(
    query,
  );
}

function invalid(reason: SearchErrorReason, message: string): SearchError {
  return { ok: false, reason, message };
}
