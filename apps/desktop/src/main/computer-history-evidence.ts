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
import { historyApplicationBlocked, historyApplicationId } from '@maka/core/computer-history';

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
  const bundleIdentifier = historyApplicationId(app) ?? '';
  const name = plain(app.name, 256);
  const domain = httpDomain(window.url);
  const domains = Array.isArray(event.contentDomains)
    ? event.contentDomains.flatMap((item) => {
      const host = canonicalDomain(item);
      return host ? [host] : [];
    })
    : [];
  if (suppressedContext(app, window, settings) ||
      domains.some((host) => blockedDomain(host, settings.blockedDomains))) return null;
  const keyboard = record(event.keyboard);
  const selection = record(event.selection);
  const selectedItems = selection.selectedItems ?? [];
  if (selection.selectedItems === null || !Array.isArray(selectedItems) || selectedItems.length > 32 ||
      selectedItems.some((item) => item === null || typeof item !== 'object' || Array.isArray(item))) return null;
  const mouse = record(event.mouse);
  const endpoints = [record(mouse.origin), record(mouse.destination)];
  const elements = [record(keyboard.target), record(selection.target), record(mouse.target)];
  if (endpoints.some((endpoint) => suppressedContext(record(endpoint.app), record(endpoint.window), settings)) ||
      [...elements, ...selectedItems.map(record), ...endpoints.map((endpoint) => record(endpoint.element))]
        .some((element) => ['role', 'subrole'].some((key) => element[key] != null &&
          (typeof element[key] !== 'string' || SECURE_ROLE.test(element[key]))))) return null;
  const kind = plain(event.kind, 80);
  if (!kind) return null;
  const sourceId = typeof event.sourceId === 'string' && SOURCE_ID.test(event.sourceId) ? event.sourceId : undefined;
  const title = plain(window.title, 1024);
  const contentAllowed = settings.summaryTextEnabled && event.contentState === 'available' && sourceId !== undefined &&
    Array.isArray(event.contentDomains) && domains.length === event.contentDomains.length && domains.length <= 64;
  const ax = record(event.ax);
  const pieces: string[] = [];
  if (contentAllowed) {
    if (kind === 'keyboard.shortcut' || kind === 'keyboard.submit') {
      const key = plain(observedText(keyboard.keyEquivalent, 64), 64);
      const combination = [...modifiers(keyboard.modifiers), ...(key ? [key] : [])].join('+');
      if (combination) pieces.push(`${kind === 'keyboard.submit'
        ? 'Submit key (not proof of success)' : 'Keyboard shortcut (not proof of completion)'}: ${combination}`);
    }
    if (kind.startsWith('mouse.')) {
      const button = typeof mouse.button === 'string' && ['left', 'right', 'middle', 'other'].includes(mouse.button)
        ? mouse.button : undefined;
      const count = nonnegativeInteger(mouse.clickCount);
      const input = [
        button, ...(count !== undefined && count > 0 ? [`count=${count}`] : []), ...modifiers(mouse.modifiers),
      ].filter(Boolean);
      if (input.length) pieces.push(`Mouse input (not proof of completion): ${input.join(', ')}`);
      for (const [index, endpoint] of endpoints.entries()) {
        const endpointApp = record(endpoint.app);
        const endpointWindow = record(endpoint.window);
        const label = index === 0 ? 'Drag origin' : 'Drag destination';
        const context = [
          observedText(endpointApp.name, 256), observedText(endpointWindow.title, 1024),
          httpDomain(endpointWindow.url), elementDescription(record(endpoint.element)),
        ].filter(Boolean);
        if (context.length) pieces.push(`${label}:\n${context.join('\n')}`);
      }
    }
    const range = record(selection.selectedRange);
    const start = nonnegativeInteger(selection.selectedRange === undefined ? selection.start : range.location);
    const length = nonnegativeInteger(range.length);
    if (start !== undefined && (selection.selectedRange === undefined ||
        (length !== undefined && Number.isSafeInteger(start + length)))) {
      pieces.push(`Selection range (UTF-16): start=${start}${length === undefined ? '' : `, length=${length}`}`);
    }
    const selected = observedText(selection.selectedText, 8 * 1024);
    const characters = observedText(keyboard.text, 8 * 1024);
    if (characters) pieces.push(`Observed input characters (not proof of committed text or submission):\n${characters}`);
    if (selected) pieces.push(`Selected text${selection.truncated === true ? ' (partial)' : ''}:\n${selected}`);
    for (const [label, element] of [['Keyboard target', elements[0]], ['Selection target', elements[1]], ['Mouse target', elements[2]]] as const) {
      const description = elementDescription(element);
      if (description) pieces.push(`${label}:\n${description}`);
    }
    for (const [index, item] of selectedItems.entries()) {
      const description = elementDescription(record(item));
      if (description) pieces.push(`Selected item ${index + 1}:\n${description}`);
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

function suppressedContext(
  app: Record<string, unknown>,
  window: Record<string, unknown>,
  settings: ComputerHistorySettings,
): boolean {
  const domain = httpDomain(window.url);
  return domain === null || historyApplicationBlocked(app, settings.blockedApplications) ||
    Boolean(domain && blockedDomain(domain, settings.blockedDomains)) ||
    app.secureInput === true || window.isPrivate === true || window.privateBrowsing === true;
}

function elementDescription(element: Record<string, unknown>): string {
  return ['role', 'title', 'description', 'value', 'placeholder']
    .flatMap((key) => typeof element[key] === 'string'
      ? [`${key}: ${observedText(element[key], key === 'value' ? 8 * 1024 : 1024)}`] : []).join('\n');
}

function modifiers(value: unknown): string[] {
  const allowed = ['command', 'control', 'option', 'shift', 'fn', 'alt', 'meta'];
  return Array.isArray(value) ? allowed.filter((modifier) => value.includes(modifier)) : [];
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
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

function httpDomain(value: unknown): string | null | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? canonicalDomain(url.hostname) ?? null : undefined;
  } catch {
    return null;
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
