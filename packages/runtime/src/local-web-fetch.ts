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
  '100.100.100.200',
  'fd00:ec2::254',
  '::ffff:a9fe:a9fe',
  'instance-data.ec2.internal',
  'metadata.google.internal',
  'metadata.goog',
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 10;
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
  const decoder = new TextDecoder();
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
  if (BLOCKED_CLOUD_METADATA_HOSTS.has(hostname)) {
    throw new Error('WebFetch cloud metadata target is not allowed.');
  }
}

function htmlToMarkdown(html: string, pageUrl: string): string {
  const { document } = parseHTML(html);
  for (const element of document.querySelectorAll<HTMLElement>('[href]')) {
    const href = element.getAttribute('href');
    if (!href) continue;
    try {
      element.setAttribute('href', new URL(href, pageUrl).toString());
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

function defaultUserAgent(): string {
  return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128 Safari/537.36 Maka/0.1';
}
