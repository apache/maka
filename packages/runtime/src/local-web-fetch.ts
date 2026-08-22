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

import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import type { WebFetchExecutor } from './web-fetch-tool.js';

interface LocalWebFetchInput {
  readonly fetch: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

const BLOCKED_CLOUD_METADATA_HOSTS = new Set([
  '169.254.169.254',
  '169.254.170.2',
  '169.254.170.23',
  '100.100.100.200',
  'fd00:ec2::254',
  'fd00:ec2::23',
  '::ffff:a9fe:a9fe',
  'instance-data.ec2.internal',
  'metadata.google.internal',
  'metadata.goog',
  'metadata.tencentyun.com',
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 10;
const MAX_HTML_NESTING_DEPTH = 512;
const VOID_HTML_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
const RAW_TEXT_HTML_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);
export const WEB_FETCH_RESPONSE_MAX_BYTES = 5 * 1024 * 1024;
export const WEB_FETCH_TIMEOUT_MS = 30_000;

export function createLocalWebFetchExecutor(input: LocalWebFetchInput): WebFetchExecutor {
  return {
    fetch: async ({ url, abortSignal }) => {
      const timeoutMs = input.timeoutMs ?? WEB_FETCH_TIMEOUT_MS;
      const timeout = new AbortController();
      const timer = setTimeout(
        () => timeout.abort(new Error(`WebFetch timed out after ${timeoutMs} ms.`)),
        timeoutMs,
      );
      const signal = abortSignal ? AbortSignal.any([abortSignal, timeout.signal]) : timeout.signal;
      try {
        let currentUrl = new URL(url);
        let response: Response | undefined;
        for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
          assertAllowedTarget(currentUrl);
          response = await input.fetch(currentUrl, {
            method: 'GET',
            redirect: 'manual',
            headers: { 'user-agent': defaultUserAgent() },
            signal,
          });
          if (!REDIRECT_STATUSES.has(response.status)) break;
          if (redirects === MAX_REDIRECTS) {
            await response.body?.cancel();
            throw new Error(`WebFetch exceeded ${MAX_REDIRECTS} redirects.`);
          }
          const location = response.headers.get('location');
          if (!location) {
            await response.body?.cancel();
            throw new Error('WebFetch redirect response is missing a Location header.');
          }
          await response.body?.cancel();
          currentUrl = new URL(location, currentUrl);
        }
        if (!response) throw new Error('WebFetch did not receive a response.');
        if (!response.ok) {
          await response.body?.cancel();
          const status = response.statusText
            ? `${response.status} ${response.statusText}`
            : String(response.status);
          throw new Error(`WebFetch HTTP error: ${status}`);
        }
        const body = await readBoundedText(response);
        const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
        const content =
          contentType.includes('text/html') || contentType.includes('application/xhtml+xml')
            ? htmlToMarkdown(body, response.url || currentUrl.toString())
            : body;
        if (!content.trim()) throw new Error('WebFetch returned an empty body.');
        return content;
      } catch (error) {
        if (timeout.signal.aborted && !abortSignal?.aborted) throw timeout.signal.reason;
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function readBoundedText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > WEB_FETCH_RESPONSE_MAX_BYTES) {
    await response.body?.cancel();
    throw responseLimitError();
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = responseTextDecoder(response);
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > WEB_FETCH_RESPONSE_MAX_BYTES) {
        await reader.cancel();
        throw responseLimitError();
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function responseTextDecoder(response: Response): TextDecoder {
  const contentType = response.headers.get('content-type') ?? '';
  const charset = /(?:^|;)\s*charset\s*=\s*"?([^;"\s]+)/i.exec(contentType)?.[1];
  if (!charset) return new TextDecoder();
  try {
    return new TextDecoder(charset);
  } catch {
    return new TextDecoder();
  }
}

function responseLimitError(): Error {
  return new Error('WebFetch response exceeds the 5 MB response limit.');
}

function assertAllowedTarget(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('WebFetch URL must use HTTP or HTTPS.');
  }
  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (
    BLOCKED_CLOUD_METADATA_HOSTS.has(hostname) ||
    BLOCKED_CLOUD_METADATA_HOSTS.has(ipv4FromMappedIpv6(hostname) ?? '')
  ) {
    throw new Error('WebFetch cloud metadata target is not allowed.');
  }
}

function ipv4FromMappedIpv6(hostname: string): string | null {
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(hostname);
  if (!match) return null;
  const high = Number.parseInt(match[1]!, 16);
  const low = Number.parseInt(match[2]!, 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function htmlToMarkdown(html: string, pageUrl: string): string {
  assertSafeHtmlNesting(html);
  const { document } = parseHTML(html);
  const baseHref = document.querySelector('base[href]')?.getAttribute('href');
  let linkBaseUrl = pageUrl;
  if (baseHref) {
    try {
      linkBaseUrl = new URL(baseHref, pageUrl).toString();
    } catch {
      // Fall back to the response URL for a malformed page-authored base URL.
    }
  }
  for (const element of document.querySelectorAll<HTMLElement>('[href]')) {
    const href = element.getAttribute('href');
    if (!href) continue;
    try {
      element.setAttribute('href', new URL(href, linkBaseUrl).toString());
    } catch {
      // Keep malformed page-authored links as-is.
    }
  }
  const article = new Readability(document as unknown as Document).parse();
  const readableHtml = article?.content ?? document.body?.innerHTML ?? '';
  return new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
    .turndown(readableHtml)
    .trim();
}

function assertSafeHtmlNesting(html: string): void {
  const stack: string[] = [];
  const tags = /<\/?([a-z][^\s/>]*)\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(html))) {
    const source = match[0];
    const name = match[1]!.toLowerCase();
    if (source.startsWith('</')) {
      const index = stack.lastIndexOf(name);
      if (index >= 0) stack.length = index;
      continue;
    }
    if (source.endsWith('/>') || VOID_HTML_ELEMENTS.has(name)) continue;
    if (RAW_TEXT_HTML_ELEMENTS.has(name)) {
      const closingTag = new RegExp(`</${name}\\s*>`, 'gi');
      closingTag.lastIndex = tags.lastIndex;
      const closingMatch = closingTag.exec(html);
      if (closingMatch) tags.lastIndex = closingTag.lastIndex;
      continue;
    }
    stack.push(name);
    if (stack.length > MAX_HTML_NESTING_DEPTH) {
      throw new Error(
        `WebFetch HTML nesting exceeds the safety limit of ${MAX_HTML_NESTING_DEPTH}.`,
      );
    }
  }
}

function defaultUserAgent(): string {
  return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128 Safari/537.36 Maka/0.1';
}
