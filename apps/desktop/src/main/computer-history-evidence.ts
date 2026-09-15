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

import { createHash } from 'node:crypto';
import { redactSecrets } from '@maka/core/redaction';
import type { ComputerHistorySettings } from '@maka/core/computer-history';
import type { ComputerHistorySummaryEvent } from './computer-history-summaries.js';

const MAX_CONTENT_BYTES = 28 * 1024;
const SOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SECURE_ROLE = /secure|password/iu;

/** Source policy scopes derived summaries as well as retained raw evidence. */
export function summaryScopeKey(settings: ComputerHistorySettings): string {
  return createHash('sha256').update(JSON.stringify({
    applications: [...settings.blockedApplications].sort(),
    domains: [...settings.blockedDomains].sort(),
  })).digest('hex');
}

/** This projection is main-only. Never serialize a raw collector object into model input. */
export function projectHistorySummaryEvent(
  line: string,
  settings: ComputerHistorySettings,
): ComputerHistorySummaryEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const outer = record(value);
  const event = record(outer.event ?? outer);
  if (typeof event.timestamp !== 'string' || !Number.isFinite(Date.parse(event.timestamp))) return null;
  const app = record(event.app);
  const window = record(event.window);
  const bundleIdentifier = plain(app.bundleIdentifier, 256);
  const name = plain(app.name, 256);
  const domain = httpDomain(window.url);
  const domains = Array.isArray(event.contentDomains)
    ? event.contentDomains.flatMap((item) => {
      const host = canonicalDomain(item);
      return host ? [host] : [];
    })
    : [];
  if (settings.blockedApplications.includes(bundleIdentifier) ||
      [domain, ...domains].some((host) => host && blockedDomain(host, settings.blockedDomains)) ||
      app.secureInput === true || window.isPrivate === true || window.privateBrowsing === true) return null;
  const keyboard = record(event.keyboard);
  const selection = record(event.selection);
  const mouse = record(event.mouse);
  const elements = [record(keyboard.target), record(selection.target), record(mouse.target)];
  if (elements.some((element) => SECURE_ROLE.test(`${element.role ?? ''} ${element.subrole ?? ''}`))) return null;
  const kind = plain(event.kind, 80);
  if (!kind) return null;
  const sourceId = typeof event.sourceId === 'string' && SOURCE_ID.test(event.sourceId) ? event.sourceId : undefined;
  const title = plain(window.title, 1024);
  const contentAllowed = settings.summaryTextEnabled && event.contentState === 'available' && sourceId !== undefined &&
    Array.isArray(event.contentDomains) && domains.length === event.contentDomains.length && domains.length <= 64;
  const ax = record(event.ax);
  const pieces: string[] = [];
  if (contentAllowed) {
    const selected = observedText(selection.selectedText, 4 * 1024);
    const typed = observedText(keyboard.text, 4 * 1024);
    if (typed) pieces.push(`Entered text (not proof of submission):\n${typed}`);
    if (selected) pieces.push(`Selected text${selection.truncated === true ? ' (partial)' : ''}:\n${selected}`);
    for (const [label, element] of [['Keyboard target', elements[0]], ['Selection target', elements[1]], ['Mouse target', elements[2]]] as const) {
      const description = ['role', 'title', 'description', 'value', 'placeholder']
        .flatMap((key) => typeof element[key] === 'string' ? [`${key}: ${observedText(element[key], 1024)}`] : []);
      if (description.length) pieces.push(`${label}:\n${description.join('\n')}`);
    }
    // Legacy deltas cannot establish a self-contained permitted document.
    if (ax.mode === 'fullTree' && typeof ax.text === 'string') {
      pieces.push(`Visible accessibility content${ax.truncated === true ? ' (partial)' : ''}:\n${observedText(ax.text, MAX_CONTENT_BYTES)}`);
    }
  }
  const content = text(pieces.join('\n\n'), MAX_CONTENT_BYTES);
  return {
    timestamp: new Date(event.timestamp).toISOString(),
    kind,
    sourceKey: createHash('sha256').update(JSON.stringify([bundleIdentifier || name, sourceId ?? title])).digest('hex'),
    app: { name: plain(observedText(app.name, 256), 256), bundleIdentifier },
    window: { title: plain(observedText(window.title, 1024), 1024), ...(domain ? { urlDomain: domain } : {}) },
    ...(content ? { content } : {}),
  };
}

function blockedDomain(host: string, blocked: readonly string[]): boolean {
  const normalized = host.toLowerCase().replace(/\.$/u, '');
  return blocked.some((entry) => {
    const domain = canonicalDomain(entry);
    return domain !== undefined && (normalized === domain || normalized.endsWith(`.${domain}`));
  });
}

function canonicalDomain(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 253 || /[\s/@?#:\\]/u.test(value)) return undefined;
  try {
    const url = new URL(`https://${value}`);
    const host = url.hostname.toLowerCase().replace(/\.$/u, '');
    return host && host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label))
      ? host : undefined;
  } catch {
    return undefined;
  }
}

function httpDomain(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function plain(value: unknown, bytes: number): string {
  return text(value, bytes).replace(/[\u0000-\u001f\u007f]/gu, ' ').trim();
}

function observedText(value: unknown, bytes: number): string {
  // Redact before clipping: a budget boundary must not split a recognizable secret.
  return text(typeof value === 'string' ? redactSecrets(value) : value, bytes);
}

function text(value: unknown, bytes: number): string {
  if (typeof value !== 'string') return '';
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
  if (Buffer.byteLength(clean) <= bytes) return clean;
  const marker = '\n[truncated]';
  let prefix = '';
  let length = Buffer.byteLength(marker);
  for (const character of clean) {
    length += Buffer.byteLength(character);
    if (length > bytes) break;
    prefix += character;
  }
  return prefix + marker;
}
