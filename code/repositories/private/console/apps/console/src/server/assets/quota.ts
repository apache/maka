import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { toCnIso } from '@ggbdpq/console-shared';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
const DEFAULT_TIMEOUT_MS = 8_000;

export type AccountQuotaHealth = 'healthy' | 'quota_low' | 'quota_exhausted' | 'auth_error' | 'unknown';

export interface NormalizedQuotaWindow {
  key: string;
  label: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetAt: string | null;
  resetAfterSeconds: number | null;
  limitWindowSeconds: number | null;
  limitReached: boolean | null;
  allowed: boolean | null;
}

export interface NormalizedQuotaSnapshot {
  source: 'openai_wham';
  planType: string | null;
  quotaPercent: number;
  usedPercent: number | null;
  resetAt: string | null;
  windowLabel: string | null;
  windowSeconds: number | null;
  limitReached: boolean;
  allowed: boolean | null;
  subscriptionActiveUntil: string | null;
  resetCreditsAvailable: number | null;
  resetCreditsApplicableAvailable: number | null;
  resetCreditsExpiresAt: string | null;
  resetCreditsError: string | null;
  health: AccountQuotaHealth;
  windows: NormalizedQuotaWindow[];
  raw: {
    usage: unknown;
    resetCredits?: unknown;
  };
}

export interface RefreshQuotaInput {
  accessToken: string | null | undefined;
  accountId?: string | null;
  proxyUrl?: string | null;
  timeoutMs?: number;
}

interface ResponseLike {
  ok?: boolean;
  status: number;
  statusText?: string;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<ResponseLike>;

export class QuotaRefreshError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'QuotaRefreshError';
    this.status = status;
  }
}

export function readCliProxyProxyUrl(text: string): string | null {
  const match = text.match(/^\s*proxy-url\s*:\s*['"]?([^'"\r\n#]+)['"]?/m);
  return match?.[1]?.trim() || null;
}

export function findCliProxyProxyUrl(configPath = path.join(os.homedir(), 'CLIProxyAPI', 'config.yaml')): string | null {
  try {
    return readCliProxyProxyUrl(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function read(obj: unknown, ...keys: string[]): unknown {
  if (!isRecord(obj)) return undefined;
  for (const key of keys) {
    if (key in obj) return obj[key];
  }
  return undefined;
}

function readString(obj: unknown, ...keys: string[]): string | null {
  const value = read(obj, ...keys);
  return typeof value === 'string' && value.trim() ? value : null;
}

function readNumber(obj: unknown, ...keys: string[]): number | null {
  const value = read(obj, ...keys);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function readBoolean(obj: unknown, ...keys: string[]): boolean | null {
  const value = read(obj, ...keys);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : null;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizePercent(value: number | null): number | null {
  if (value == null) return null;
  const normalized = value > 0 && value <= 1 ? value * 100 : value;
  return clampPercent(normalized);
}

function labelByWindowSeconds(seconds: number | null, prefix = '', fallback = '限额'): string {
  const head = prefix ? `${prefix}` : '';
  if (seconds === 18_000) return `${head}5 小时限额`;
  if (seconds === 604_800) return `${head}周限额`;
  if (seconds != null && seconds >= 2_419_200 && seconds <= 2_678_400) return `${head}月度限额`;
  if (seconds != null && seconds > 0 && seconds % 3_600 === 0) return `${head}${seconds / 3_600} 小时限额`;
  return `${head}${fallback}`;
}

function normalizeResetAt(raw: unknown, resetAfterSeconds: number | null, nowMs: number): string | null {
  const resetAt = readString(raw, 'reset_at', 'resetAt');
  if (resetAt) return resetAt;
  if (resetAfterSeconds == null) return null;
  return toCnIso(nowMs + resetAfterSeconds * 1000);
}

function normalizeWindow(
  raw: unknown,
  key: string,
  prefix: string,
  fallback: string,
  nowMs: number,
): NormalizedQuotaWindow | null {
  if (!isRecord(raw)) return null;
  const usedPercent = normalizePercent(readNumber(raw, 'used_percent', 'usedPercent'));
  const remainingPercent = usedPercent == null ? null : clampPercent(100 - usedPercent);
  const seconds = readNumber(raw, 'limit_window_seconds', 'limitWindowSeconds');
  const resetAfterSeconds = readNumber(raw, 'reset_after_seconds', 'resetAfterSeconds');
  return {
    key,
    label: labelByWindowSeconds(seconds, prefix, fallback),
    usedPercent,
    remainingPercent,
    resetAt: normalizeResetAt(raw, resetAfterSeconds, nowMs),
    resetAfterSeconds,
    limitWindowSeconds: seconds == null ? null : Math.round(seconds),
    limitReached: readBoolean(raw, 'limit_reached', 'limitReached'),
    allowed: readBoolean(raw, 'allowed'),
  };
}

function collectRateLimitWindows(raw: unknown, prefix = '', keyPrefix = 'codex', nowMs = Date.now()): NormalizedQuotaWindow[] {
  if (!isRecord(raw)) return [];
  const windows: NormalizedQuotaWindow[] = [];
  const primary = normalizeWindow(
    read(raw, 'primary_window', 'primaryWindow'),
    `${keyPrefix}.primary`,
    prefix,
    '主限额',
    nowMs,
  );
  const secondary = normalizeWindow(
    read(raw, 'secondary_window', 'secondaryWindow'),
    `${keyPrefix}.secondary`,
    prefix,
    '副限额',
    nowMs,
  );
  if (primary) windows.push(primary);
  if (secondary) windows.push(secondary);
  if (windows.length === 0) {
    const single = normalizeWindow(raw, keyPrefix, prefix, '限额', nowMs);
    if (single) windows.push(single);
  }
  return windows;
}

function collectWindows(usage: unknown, nowMs: number): NormalizedQuotaWindow[] {
  const windows: NormalizedQuotaWindow[] = [];
  windows.push(...collectRateLimitWindows(read(usage, 'rate_limit', 'rateLimit'), '', 'codex', nowMs));
  windows.push(
    ...collectRateLimitWindows(
      read(usage, 'code_review_rate_limit', 'codeReviewRateLimit'),
      '代码审查',
      'code_review',
      nowMs,
    ),
  );

  for (const [index, item] of asArray(read(usage, 'additional_rate_limits', 'additionalRateLimits')).entries()) {
    const label = readString(item, 'label', 'name', 'type') ?? `附加限额 ${index + 1}`;
    windows.push(...collectRateLimitWindows(item, `${label} `, `additional.${index}`, nowMs));
  }

  return windows;
}

function pickLimitingWindow(windows: NormalizedQuotaWindow[]): NormalizedQuotaWindow | null {
  const withRemaining = windows.filter((w) => w.remainingPercent != null);
  if (withRemaining.length === 0) return windows[0] ?? null;
  return [...withRemaining].sort((a, b) => {
    const aReached = a.limitReached === true || a.allowed === false ? 1 : 0;
    const bReached = b.limitReached === true || b.allowed === false ? 1 : 0;
    if (aReached !== bReached) return bReached - aReached;
    return (a.remainingPercent ?? 100) - (b.remainingPercent ?? 100);
  })[0];
}

function earliestAvailableCreditExpiry(resetCredits: unknown): string | null {
  const candidates = asArray(read(resetCredits, 'credits'))
    .filter((credit) => {
      const resetType = readString(credit, 'reset_type', 'resetType');
      const status = readString(credit, 'status');
      return (!resetType || resetType === 'codex_rate_limits') && (!status || status === 'available');
    })
    .map((credit) => readString(credit, 'expires_at', 'expiresAt'))
    .filter((expiresAt): expiresAt is string => Boolean(expiresAt))
    .sort();
  return candidates[0] ?? null;
}

function deriveHealth(windows: NormalizedQuotaWindow[], quotaPercent: number): AccountQuotaHealth {
  if (windows.some((w) => w.limitReached === true || w.allowed === false || w.remainingPercent === 0)) {
    return 'quota_exhausted';
  }
  if (windows.length === 0) return 'unknown';
  if (quotaPercent <= 15) return 'quota_low';
  return 'healthy';
}

export function normalizeOpenAIQuotaSnapshot(
  usage: unknown,
  resetCredits?: unknown,
  nowMs = Date.now(),
): NormalizedQuotaSnapshot {
  const windows = collectWindows(usage, nowMs);
  const limitingWindow = pickLimitingWindow(windows);
  const forcedExhausted = windows.some((w) => w.limitReached === true || w.allowed === false);
  const quotaPercent = forcedExhausted ? 0 : (limitingWindow?.remainingPercent ?? 100);
  const allowed = windows.some((w) => w.allowed === false)
    ? false
    : windows.some((w) => w.allowed === true)
      ? true
      : null;

  return {
    source: 'openai_wham',
    planType: readString(usage, 'plan_type', 'planType'),
    quotaPercent,
    usedPercent: limitingWindow?.usedPercent ?? null,
    resetAt: limitingWindow?.resetAt ?? null,
    windowLabel: limitingWindow?.label ?? null,
    windowSeconds: limitingWindow?.limitWindowSeconds ?? null,
    limitReached: forcedExhausted,
    allowed,
    subscriptionActiveUntil: readString(
      usage,
      'subscription_active_until',
      'subscriptionActiveUntil',
      'chatgpt_subscription_active_until',
      'chatgptSubscriptionActiveUntil',
    ),
    resetCreditsAvailable: readNumber(resetCredits, 'available_count', 'availableCount'),
    resetCreditsApplicableAvailable: readNumber(
      resetCredits,
      'applicable_available_count',
      'applicableAvailableCount',
    ),
    resetCreditsExpiresAt: earliestAvailableCreditExpiry(resetCredits),
    resetCreditsError: null,
    health: deriveHealth(windows, quotaPercent),
    windows,
    raw: {
      usage,
      resetCredits,
    },
  };
}

async function responseBody(response: ResponseLike): Promise<unknown> {
  if (typeof response.json === 'function') return await response.json();
  if (typeof response.text === 'function') {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return null;
}

function errorText(body: unknown): string {
  if (typeof body === 'string') return body.slice(0, 500);
  if (isRecord(body)) {
    const detail = readString(body, 'detail', 'message', 'error');
    if (detail) return detail;
    return JSON.stringify(body).slice(0, 500);
  }
  return '';
}

async function fetchJson(url: string, init: RequestInit, fetchLike: FetchLike, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchLike(url, { ...init, signal: controller.signal });
    const body = await responseBody(response);
    const ok = response.ok ?? (response.status >= 200 && response.status < 300);
    if (!ok) {
      const suffix = errorText(body);
      throw new QuotaRefreshError(
        `OpenAI 额度接口返回 ${response.status}${suffix ? `：${suffix}` : ''}`,
        response.status,
      );
    }
    return body;
  } catch (error) {
    if (error instanceof QuotaRefreshError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new QuotaRefreshError('OpenAI 额度接口请求超时');
    }
    throw new QuotaRefreshError(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}

function requestHeaders(input: RefreshQuotaInput): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal',
  };
  if (input.accountId) headers['Chatgpt-Account-Id'] = input.accountId;
  return headers;
}

function headersToRecord(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};
  if (Array.isArray(headers)) return Object.fromEntries(headers.map(([k, v]) => [k, String(v)]));
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)]));
}

function waitForSocketConnect(socket: net.Socket, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off('connect', onConnect);
      socket.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      socket.destroy();
      reject(new QuotaRefreshError('OpenAI 额度接口请求已取消'));
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function waitForTlsConnect(socket: tls.TLSSocket, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off('secureConnect', onConnect);
      socket.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      socket.destroy();
      reject(new QuotaRefreshError('OpenAI 额度接口请求已取消'));
    };
    socket.once('secureConnect', onConnect);
    socket.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function readSocksChunk(socket: net.Socket, enough: (buffer: Buffer) => boolean, signal?: AbortSignal | null): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (enough(buffer)) {
        cleanup();
        resolve(buffer);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      socket.destroy();
      reject(new QuotaRefreshError('OpenAI 额度接口请求已取消'));
    };
    socket.on('data', onData);
    socket.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function socks5Connect(proxyUrl: string, targetHost: string, targetPort: number, signal?: AbortSignal | null) {
  const proxy = new URL(proxyUrl);
  const proxyPort = Number(proxy.port || 1080);
  const socket = net.connect(proxyPort, proxy.hostname);
  await waitForSocketConnect(socket, signal);

  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  const hello = await readSocksChunk(socket, (buf) => buf.length >= 2, signal);
  if (hello[0] !== 0x05 || hello[1] !== 0x00) {
    socket.destroy();
    throw new QuotaRefreshError('SOCKS5 代理未接受无鉴权连接');
  }

  const host = Buffer.from(targetHost, 'utf-8');
  if (host.length > 255) {
    socket.destroy();
    throw new QuotaRefreshError('SOCKS5 目标域名过长');
  }
  const port = Buffer.alloc(2);
  port.writeUInt16BE(targetPort, 0);
  socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, port]));
  const response = await readSocksChunk(socket, (buf) => {
    if (buf.length < 5) return false;
    if (buf[3] === 0x01) return buf.length >= 10;
    if (buf[3] === 0x04) return buf.length >= 22;
    if (buf[3] === 0x03) return buf.length >= 5 + buf[4] + 2;
    return true;
  }, signal);
  if (response[1] !== 0x00) {
    socket.destroy();
    throw new QuotaRefreshError(`SOCKS5 连接失败：${response[1]}`);
  }
  return socket;
}

function decodeChunked(body: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < body.length) {
    const lineEnd = body.indexOf('\r\n', offset, 'utf-8');
    if (lineEnd < 0) break;
    const sizeText = body.slice(offset, lineEnd).toString('utf-8').split(';')[0];
    const size = parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size < 0) break;
    if (size === 0) break;
    const start = lineEnd + 2;
    const end = start + size;
    if (end > body.length) break;
    chunks.push(body.slice(start, end));
    offset = end + 2;
  }
  return Buffer.concat(chunks);
}

function parseHttpResponse(raw: Buffer): ResponseLike {
  const split = raw.indexOf('\r\n\r\n', 0, 'utf-8');
  if (split < 0) throw new QuotaRefreshError('OpenAI 额度接口响应格式异常');
  const headerText = raw.slice(0, split).toString('utf-8');
  const bodyBytes = raw.slice(split + 4);
  const [statusLine, ...headerLines] = headerText.split('\r\n');
  const [, codeText, ...statusTextParts] = statusLine.split(' ');
  const status = Number(codeText);
  const headers = new Map<string, string>();
  for (const line of headerLines) {
    const index = line.indexOf(':');
    if (index > 0) headers.set(line.slice(0, index).toLowerCase(), line.slice(index + 1).trim());
  }
  const body = headers.get('transfer-encoding')?.toLowerCase().includes('chunked')
    ? decodeChunked(bodyBytes)
    : bodyBytes;
  const text = body.toString('utf-8');
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: statusTextParts.join(' '),
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

function createSocks5Fetch(proxyUrl: string): FetchLike {
  return async (input, init) => {
    const target = new URL(input);
    if (target.protocol !== 'https:') throw new QuotaRefreshError('SOCKS5 代理传输仅支持 HTTPS');
    if (init?.method && init.method !== 'GET') throw new QuotaRefreshError('SOCKS5 代理传输当前仅支持 GET');
    const signal = init?.signal;
    if (signal?.aborted) throw new QuotaRefreshError('OpenAI 额度接口请求已取消');

    const socket = await socks5Connect(proxyUrl, target.hostname, Number(target.port || 443), signal);
    const secureSocket = tls.connect({ socket, servername: target.hostname });
    await waitForTlsConnect(secureSocket, signal);

    const headers = {
      Host: target.host,
      Connection: 'close',
      ...headersToRecord(init?.headers),
    };
    const request =
      `GET ${target.pathname}${target.search} HTTP/1.1\r\n` +
      Object.entries(headers)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\r\n') +
      '\r\n\r\n';
    secureSocket.write(request);

    const raw = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const cleanup = () => {
        secureSocket.off('data', onData);
        secureSocket.off('end', onEnd);
        secureSocket.off('error', onError);
        signal?.removeEventListener('abort', onAbort);
      };
      const onData = (chunk: Buffer) => chunks.push(chunk);
      const onEnd = () => {
        cleanup();
        resolve(Buffer.concat(chunks));
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        cleanup();
        secureSocket.destroy();
        reject(new QuotaRefreshError('OpenAI 额度接口请求已取消'));
      };
      secureSocket.on('data', onData);
      secureSocket.once('end', onEnd);
      secureSocket.once('error', onError);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    return parseHttpResponse(raw);
  };
}

function resolveFetch(input: RefreshQuotaInput, fetchLike?: FetchLike): FetchLike {
  if (fetchLike) return fetchLike;
  if (input.proxyUrl) {
    const protocol = new URL(input.proxyUrl).protocol;
    if (protocol === 'socks5:' || protocol === 'socks5h:') return createSocks5Fetch(input.proxyUrl);
    throw new QuotaRefreshError(`暂不支持的 proxy-url 协议：${protocol}`);
  }
  return globalThis.fetch as FetchLike;
}

export async function refreshQuotaFromOpenAI(
  input: RefreshQuotaInput,
  fetchLike?: FetchLike,
): Promise<NormalizedQuotaSnapshot> {
  if (!input.accessToken) throw new QuotaRefreshError('缺少 access_token，无法刷新真实额度');

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseHeaders = requestHeaders(input);
  const transport = resolveFetch(input, fetchLike);
  const usage = await fetchJson(USAGE_URL, { method: 'GET', headers: baseHeaders }, transport, timeoutMs);

  let resetCredits: unknown;
  let resetCreditsError: string | null = null;
  try {
    resetCredits = await fetchJson(
      RESET_CREDITS_URL,
      {
        method: 'GET',
        headers: {
          ...baseHeaders,
          'OpenAI-Beta': 'codex-1',
          Originator: 'Codex Desktop',
        },
      },
      transport,
      timeoutMs,
    );
  } catch (error) {
    resetCreditsError = error instanceof Error ? error.message : String(error);
  }

  const snapshot = normalizeOpenAIQuotaSnapshot(usage, resetCredits);
  if (snapshot.windows.length === 0) {
    throw new QuotaRefreshError('OpenAI 额度响应缺少 rate_limit 窗口');
  }
  snapshot.resetCreditsError = resetCreditsError;
  return snapshot;
}
