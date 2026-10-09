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

// Guided onboarding by QR code for 钉钉, 飞书/Lark, 企业微信, 微信 and QQ.
//
// A port of `BotOnboardingService` in Maka Desktop's
// apps/desktop/src/main/bot-onboarding-main.ts, with the QQ bind task of
// qq-bot-scan-login.ts and the WeChat iLink sign-in of wechat-scan-login.ts.
// The providers' endpoints, the polling interval, the expiry, the slow-down
// and the retry of transient failures are Desktop's. Three things are this
// client's own:
//
// - Nothing is saved here. A confirmed scan hands the channel fields
//   (`channelPatchFromCredential`) to the client, which owns bot-chat.json;
//   it saves them, applies the settings, and calls `finish`, which reads the
//   channel's live status as Desktop's `connectionWarning` does.
// - The QR code is not drawn here: a snapshot carries the text the code
//   encodes (or the image a provider sent), and the client draws it.
// - Every request goes through `fetch` (`proxiedFetch` of `@maka/runtime/bots`,
//   which Desktop's adapters use too; Desktop's WeChat sign-in uses Electron's
//   session fetch instead), so the tests can answer them from a fake.

import { createDecipheriv, randomBytes, randomUUID } from 'node:crypto';

const REQUEST_TIMEOUT_MS = 15_000;
const QQ_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MAX_POLL_INTERVAL_MS = 30_000;
const DEFAULT_EXPIRES_IN_SECONDS = 10 * 60;
const DINGTALK_EXPIRES_IN_SECONDS = 2 * 60 * 60;
/** Consecutive transient poll failures tolerated before a session goes terminal. */
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
const QQ_BIND_BASE_URL = 'https://q.qq.com';

/** `BOT_ONBOARDING_PROVIDERS` in packages/core/src/bot-onboarding.ts. */
export const BOT_ONBOARDING_PROVIDERS = ['dingtalk', 'feishu', 'wecom', 'wechat', 'qq'];

export function isOnboardingProvider(value) {
  return BOT_ONBOARDING_PROVIDERS.includes(value);
}

export function isOnboardingBrand(value) {
  return value === 'feishu' || value === 'lark';
}

/**
 * @param {object} deps
 * @param {(url: string, init?: object) => Promise<Response>} deps.fetch
 *   `proxiedFetch`: `init` takes `method`, `headers`, `body`, `signal`, `timeoutMs`
 * @param {object} deps.redaction `@maka/core/redaction`
 * @param {(provider: string) => object} deps.readStatus the channel's `BotStatus`
 * @param {(level: string, message: string) => void} [deps.log]
 * @param {string} [deps.productVersion]
 * @param {() => number} [deps.now]
 * @param {() => string} [deps.createId]
 * @param {object} [deps.adapters] replaces providers' adapters, by provider
 */
export function createBotOnboarding(deps) {
  const now = deps.now ?? Date.now;
  const createId = deps.createId ?? randomUUID;
  const log = deps.log ?? (() => {});
  const { classifyGeneralizedError, redactSecrets } = deps.redaction;
  const adapters = {
    ...createProviderAdapters({ fetch: deps.fetch, productVersion: deps.productVersion ?? '0.1.0' }),
    ...(deps.adapters ?? {}),
  };
  const sessions = new Map();
  const currentByProvider = new Map();

  function isCurrent(session) {
    return !session.controller.signal.aborted && currentByProvider.get(session.provider) === session.id;
  }

  function assertCurrent(session) {
    if (!isCurrent(session)) throw new Error('Bot onboarding session is no longer active');
  }

  function getSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error('Unknown bot onboarding session');
    return session;
  }

  function clearRetryHealth(session) {
    session.pollFailures = 0;
    session.pollFailureCategory = undefined;
  }

  /** True only when the next provider poll can run before the QR code expires. */
  function scheduleNextPoll(session) {
    const retryAt = now() + session.pollIntervalMs;
    session.nextPollAt = Math.min(retryAt, session.expiresAt ?? retryAt);
    return session.expiresAt === undefined || retryAt < session.expiresAt;
  }

  function cancelSession(session) {
    if (!session.controller.signal.aborted) session.controller.abort();
    clearRetryHealth(session);
    if (!['connected', 'expired', 'denied'].includes(session.state)) session.state = 'cancelled';
    if (currentByProvider.get(session.provider) === session.id) {
      currentByProvider.delete(session.provider);
    }
  }

  function cancelCurrent(provider) {
    const current = sessions.get(currentByProvider.get(provider));
    if (current) cancelSession(current);
  }

  /** Drops terminal and superseded sessions, keeping each provider's current one. */
  function pruneSessions() {
    for (const [id, session] of sessions) {
      if (currentByProvider.get(session.provider) === id) continue;
      if (session.controller.signal.aborted || isTerminalState(session.state)) sessions.delete(id);
    }
  }

  function describeFailure(error) {
    const message = error instanceof Error ? error.message : String(error);
    return redactSecrets(message).slice(0, 200);
  }

  function failureCode(error) {
    if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
    return classifyGeneralizedError(error) ?? 'unavailable';
  }

  function fail(session, error) {
    clearRetryHealth(session);
    session.state = 'error';
    session.errorCode = failureCode(error);
    log('warn', `[bots:${session.provider}] QR setup failed: ${describeFailure(error)}`);
  }

  function snapshot(session, includeQrCode = false) {
    const state = session.state === 'starting' ? 'waiting' : session.state;
    return {
      sessionId: session.id,
      provider: session.provider,
      ...(session.brand ? { brand: session.brand } : {}),
      state,
      // Sent once, with the first snapshot; the client keeps it.
      ...(includeQrCode && session.qr ? { qr: session.qr } : {}),
      ...(session.expiresAt !== undefined ? { expiresAt: session.expiresAt } : {}),
      nextPollAfterMs: Math.max(0, session.nextPollAt - now()),
      ...(session.pollFailureCategory && session.pollFailures > 0
        ? {
            retryHealth: {
              category: session.pollFailureCategory,
              consecutiveFailures: session.pollFailures,
            },
          }
        : {}),
      canOpenInBrowser: Boolean(session.verificationUrl),
      ...(session.identity ? { identity: { ...session.identity } } : {}),
      ...(session.errorCode ? { errorCode: session.errorCode } : {}),
      ...(session.warningCode ? { warningCode: session.warningCode } : {}),
      ...(session.warningDetail ? { warningDetail: session.warningDetail } : {}),
    };
  }

  async function pollOnce(session) {
    let providerPollSettled = false;
    try {
      const result = await adapters[session.provider].poll(session, session.controller.signal);
      providerPollSettled = true;
      assertCurrent(session);
      // A response of any kind clears the transient-failure streak.
      clearRetryHealth(session);
      switch (result.status) {
        case 'pending':
          session.state = 'waiting';
          scheduleNextPoll(session);
          break;
        case 'scanned':
          session.state = 'scanned';
          scheduleNextPoll(session);
          break;
        case 'slow_down':
          session.state = 'waiting';
          session.pollIntervalMs = Math.min(session.pollIntervalMs + 5_000, MAX_POLL_INTERVAL_MS);
          scheduleNextPoll(session);
          break;
        case 'expired':
          session.state = 'expired';
          break;
        case 'denied':
          session.state = 'denied';
          break;
        case 'confirmed': {
          // The client saves these and calls `finish`; they are handed over
          // once, with this answer, and never kept in a snapshot.
          session.state = 'connecting';
          session.identity = result.identity ?? identityFromCredential(result.credential);
          return { snapshot: snapshot(session), channel: channelPatchFromCredential(result.credential, now()) };
        }
      }
      return { snapshot: snapshot(session) };
    } catch (error) {
      if (session.controller.signal.aborted || !isCurrent(session)) {
        session.state = 'cancelled';
        return { snapshot: snapshot(session) };
      }
      // A transient blip (timeout, network, 5xx, 429) must not burn a
      // still-valid code: keep waiting, with backoff, until enough failures
      // in a row. A definite provider error is fatal at once.
      const category = providerPollSettled ? undefined : classifyTransientPollError(error);
      if (category) {
        if (session.expiresAt !== undefined && session.expiresAt <= now()) {
          clearRetryHealth(session);
          session.state = 'expired';
          return { snapshot: snapshot(session) };
        }
        session.pollFailures += 1;
        if (session.pollFailures < MAX_CONSECUTIVE_POLL_FAILURES) {
          session.pollIntervalMs = Math.min(session.pollIntervalMs + 2_000, MAX_POLL_INTERVAL_MS);
          session.pollFailureCategory = scheduleNextPoll(session) ? category : undefined;
          log('info', `[bots:${session.provider}] QR poll failed, retrying: ${describeFailure(error)}`);
          return { snapshot: snapshot(session) };
        }
      }
      fail(session, error);
      return { snapshot: snapshot(session) };
    }
  }

  return {
    /** Starts a session for `provider` (and `brand`, Feishu only); cancels its last one. */
    async start({ provider, brand }) {
      cancelCurrent(provider);
      pruneSessions();
      const session = {
        id: createId(),
        provider,
        brand: provider === 'feishu' ? (brand ?? 'feishu') : undefined,
        state: 'starting',
        pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
        nextPollAt: 0,
        controller: new AbortController(),
        pollFailures: 0,
      };
      sessions.set(session.id, session);
      currentByProvider.set(provider, session.id);
      try {
        const result = await adapters[provider].start(
          { provider, brand: session.brand },
          session.controller.signal,
        );
        assertCurrent(session);
        session.opaqueToken = result.opaqueToken;
        session.qr = qrOf(result.qrImage ?? result.qrValue);
        session.verificationUrl = result.verificationUrl;
        session.pollIntervalMs = clampPollInterval(result.pollIntervalMs);
        session.expiresAt = now() + Math.max(1, result.expiresInSeconds) * 1_000;
        scheduleNextPoll(session);
        session.state = 'waiting';
        return snapshot(session, true);
      } catch (error) {
        if (session.controller.signal.aborted || !isCurrent(session)) {
          session.state = 'cancelled';
          throw new Error('Bot onboarding cancelled');
        }
        fail(session, error);
        return snapshot(session, true);
      }
    },

    /**
     * Asks the provider whether the code was scanned, unless it is too
     * early. Resolves to `{ snapshot }`, and `channel` too when the scan was
     * confirmed.
     */
    async poll(sessionId) {
      const session = getSession(sessionId);
      if (session.state !== 'waiting' && session.state !== 'scanned') {
        return { snapshot: snapshot(session) };
      }
      if (session.expiresAt !== undefined && session.expiresAt <= now()) {
        session.state = 'expired';
        clearRetryHealth(session);
        return { snapshot: snapshot(session) };
      }
      if (session.nextPollAt > now()) return { snapshot: snapshot(session) };
      if (session.pollPromise) return session.pollPromise;
      const operation = pollOnce(session).finally(() => {
        if (session.pollPromise === operation) session.pollPromise = undefined;
      });
      session.pollPromise = operation;
      return operation;
    },

    /**
     * After the client saved and applied the confirmed channel: connected,
     * with a warning when the channel's listener is not running (Desktop's
     * `connectionWarning`).
     */
    finish(sessionId) {
      const session = getSession(sessionId);
      if (session.state !== 'connecting') return snapshot(session);
      assertCurrent(session);
      const status = deps.readStatus(session.provider);
      if (status?.identity) {
        session.identity = {
          id: status.identity.id,
          displayName: status.identity.displayName ?? status.identity.username,
        };
      }
      session.state = 'connected';
      if (!status?.running) {
        session.warningCode = 'saved_not_connected';
        const detail = connectionFailureReason(status?.reason, redactSecrets);
        if (detail) session.warningDetail = detail;
      }
      return snapshot(session);
    },

    cancel(sessionId) {
      const session = getSession(sessionId);
      cancelSession(session);
      return snapshot(session);
    },

    /** The page to open when the code cannot be scanned; HTTPS only. */
    browserUrl(sessionId) {
      const session = getSession(sessionId);
      assertCurrent(session);
      if (!session.verificationUrl) throw new Error('This onboarding session has no browser URL');
      const url = new URL(session.verificationUrl);
      if (url.protocol !== 'https:') throw new Error('Only HTTPS onboarding URLs are allowed');
      return url.toString();
    },

    dispose() {
      for (const session of sessions.values()) cancelSession(session);
      sessions.clear();
      currentByProvider.clear();
    },
  };
}

function isTerminalState(state) {
  return ['connected', 'expired', 'denied', 'cancelled', 'error'].includes(state);
}

function clampPollInterval(value) {
  if (!Number.isFinite(value)) return DEFAULT_POLL_INTERVAL_MS;
  return Math.min(Math.max(Math.round(value), 1_000), MAX_POLL_INTERVAL_MS);
}

/**
 * What the client draws: an image a provider sent (a data URL, or bare
 * base64 PNG as WeChat may send it), or the text to encode.
 */
function qrOf(raw) {
  if (typeof raw !== 'string' || !raw) throw new Error('Provider returned an empty QR payload');
  if (raw.startsWith('data:image/')) return { image: raw };
  if (raw.length > 80 && /^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    return { image: `data:image/png;base64,${raw}` };
  }
  return { text: raw };
}

/**
 * A transient poll failure worth retrying (timeout, network fault, 5xx, 429),
 * or undefined for a definite provider or protocol error.
 */
export function classifyTransientPollError(error) {
  if (!(error instanceof Error)) return undefined;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timeout';
  const message = error.message.toLowerCase();
  if (/timeout|timed out/.test(message)) return 'timeout';
  const httpMatch = message.match(/http (\d{3})/);
  if (httpMatch) {
    const status = Number(httpMatch[1]);
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'server';
  }
  if (/fetch failed|network|socket|econn|enotfound|eai_again|und_err/.test(message)) {
    return 'network';
  }
  return undefined;
}

/** The channel fields a confirmed scan sets (`channelPatchFromCredential`). */
function channelPatchFromCredential(credential, at) {
  const common = {
    enabled: true,
    connected: false,
    readiness: 'configured',
    readinessUpdatedAt: at,
  };
  switch (credential.provider) {
    case 'dingtalk':
      return { ...common, appId: credential.clientId, appSecret: credential.clientSecret };
    case 'feishu':
      return {
        ...common,
        appId: credential.appId,
        appSecret: credential.appSecret,
        domain: credential.brand === 'lark' ? 'larksuite.com' : 'feishu.cn',
      };
    case 'wecom':
      return { ...common, appId: credential.botId, appSecret: credential.secret };
    case 'wechat':
      return {
        ...common,
        token: credential.botToken,
        webhookUrl: credential.baseUrl,
        botUserId: credential.botId,
      };
    case 'qq':
      return { ...common, appId: credential.appId, appSecret: credential.appSecret };
    default:
      throw new Error('Unsupported bot onboarding credential');
  }
}

function identityFromCredential(credential) {
  switch (credential.provider) {
    case 'dingtalk':
      return { id: credential.clientId };
    case 'feishu':
      return { id: credential.appId, ...(credential.botName ? { displayName: credential.botName } : {}) };
    case 'wecom':
      return { id: credential.botId };
    case 'wechat':
      return { id: credential.botId };
    case 'qq':
      return { id: credential.appId };
    default:
      return undefined;
  }
}

/**
 * A live status reason as a short, redacted cause for "saved but not
 * connected"; lifecycle markers carry nothing useful.
 */
function connectionFailureReason(reason, redactSecrets) {
  if (typeof reason !== 'string') return undefined;
  const trimmed = redactSecrets(reason).trim();
  if (!trimmed || trimmed === 'stopped' || trimmed === 'reconnecting') return undefined;
  return trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
}

/**
 * Maps an undocumented WeCom `qc/query_result` status to a terminal outcome,
 * or undefined to keep polling (`wecomTerminalPollStatus`).
 */
export function wecomTerminalPollStatus(status) {
  if (typeof status !== 'string') return undefined;
  if (/cancel|reject|refuse/i.test(status)) return 'denied';
  if (/expire|timeout|invalid|fail/i.test(status)) return 'expired';
  return undefined;
}

function platformCode() {
  switch (process.platform) {
    case 'darwin':
      return 1;
    case 'win32':
      return 2;
    case 'linux':
      return 3;
    default:
      return 0;
  }
}

/** The providers' device-code and QR endpoints, as Desktop calls them. */
function createProviderAdapters({ fetch, productVersion }) {
  async function postJson(url, body, signal) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!response.ok) throw new Error(`Provider request failed with HTTP ${response.status}`);
    return response.json();
  }

  async function postForm(url, body, signal) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
      signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok && typeof json.error !== 'string') {
      throw new Error(`Provider request failed with HTTP ${response.status}`);
    }
    return json;
  }

  async function getJson(url, signal, what) {
    const response = await fetch(url, { signal, timeoutMs: REQUEST_TIMEOUT_MS });
    if (!response.ok) throw new Error(`${what} failed with HTTP ${response.status}`);
    return response.json();
  }

  // wechat-scan-login.ts: both iLink endpoints want `X-WECHAT-UIN`, a
  // base64-encoded random uint32, new for every request.
  async function ilinkGet(path, extraHeaders, signal) {
    const uin = Buffer.from(String(randomBytes(4).readUInt32LE(0)), 'utf-8').toString('base64');
    const response = await fetch(`${ILINK_BASE_URL}${path}`, {
      method: 'GET',
      headers: { 'X-WECHAT-UIN': uin, ...extraHeaders },
      signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON response: ${text.slice(0, 200)}`);
    }
  }

  // qq-bot-scan-login.ts.
  async function postQQBind(path, body, signal) {
    const response = await fetch(new URL(path, QQ_BIND_BASE_URL).toString(), {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
      timeoutMs: QQ_REQUEST_TIMEOUT_MS,
    });
    if (!response.ok) throw new Error(`QQ bind request failed with HTTP ${response.status}`);
    const json = await response.json();
    if (json.retcode !== 0) {
      throw new Error(
        typeof json.msg === 'string' && json.msg.length > 0
          ? `QQ bind request failed: ${json.msg}`
          : 'QQ bind request failed',
      );
    }
    return json;
  }

  async function fetchFeishuBotName(appId, appSecret, brand, signal) {
    const domain = brand === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn';
    try {
      const token = await postJson(
        `https://${domain}/open-apis/auth/v3/tenant_access_token/internal/`,
        { app_id: appId, app_secret: appSecret },
        signal,
      );
      if (typeof token.tenant_access_token !== 'string') return undefined;
      const response = await fetch(`https://${domain}/open-apis/bot/v3/info/`, {
        headers: { Authorization: `Bearer ${token.tenant_access_token}` },
        signal,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      if (!response.ok) return undefined;
      const json = await response.json();
      return typeof json.bot?.app_name === 'string' ? json.bot.app_name : undefined;
    } catch {
      return undefined;
    }
  }

  const feishuEndpoint = (brand) =>
    `https://${brand === 'lark' ? 'accounts.larksuite.com' : 'accounts.feishu.cn'}/oauth/v1/app/registration`;

  return {
    dingtalk: {
      async start(_input, signal) {
        const init = await postJson('https://oapi.dingtalk.com/app/registration/init', { source: 'MAKA' }, signal);
        if (init.errcode !== 0 || typeof init.nonce !== 'string') throw new Error('DingTalk registration init failed');
        const begin = await postJson('https://oapi.dingtalk.com/app/registration/begin', { nonce: init.nonce }, signal);
        const verificationUrl = begin.pc_verification_uri_complete ?? begin.verification_uri_complete;
        if (typeof begin.device_code !== 'string' || typeof verificationUrl !== 'string') {
          throw new Error('DingTalk registration begin returned an invalid response');
        }
        return {
          opaqueToken: begin.device_code,
          qrValue: verificationUrl,
          verificationUrl,
          pollIntervalMs: Number(begin.interval ?? 5) * 1_000,
          expiresInSeconds: Number(begin.expires_in ?? DINGTALK_EXPIRES_IN_SECONDS),
        };
      },
      async poll(session, signal) {
        const result = await postJson(
          'https://oapi.dingtalk.com/app/registration/poll',
          { device_code: session.opaqueToken },
          signal,
        );
        switch (result.status) {
          case 'SUCCESS':
            if (typeof result.client_id !== 'string' || typeof result.client_secret !== 'string') {
              throw new Error('DingTalk registration returned incomplete credentials');
            }
            return {
              status: 'confirmed',
              credential: { provider: 'dingtalk', clientId: result.client_id, clientSecret: result.client_secret },
              identity: { id: result.client_id },
            };
          case 'WAITING':
            return { status: 'pending' };
          case 'EXPIRED':
            return { status: 'expired' };
          case 'FAIL':
            return { status: 'denied' };
          default:
            throw new Error('DingTalk registration returned an unknown status');
        }
      },
    },
    feishu: {
      async start(input, signal) {
        const endpoint = feishuEndpoint(input.brand ?? 'feishu');
        const init = await postForm(endpoint, { action: 'init' }, signal);
        if (!Array.isArray(init.supported_auth_methods) || !init.supported_auth_methods.includes('client_secret')) {
          throw new Error('Feishu registration does not support client_secret');
        }
        const begin = await postForm(
          endpoint,
          { action: 'begin', archetype: 'PersonalAgent', auth_method: 'client_secret', request_user_info: 'open_id' },
          signal,
        );
        if (typeof begin.device_code !== 'string' || typeof begin.verification_uri_complete !== 'string') {
          throw new Error('Feishu registration begin returned an invalid response');
        }
        const verificationUrl = new URL(begin.verification_uri_complete);
        verificationUrl.searchParams.set('from', 'maka');
        verificationUrl.searchParams.set('lpv', productVersion);
        return {
          opaqueToken: begin.device_code,
          qrValue: verificationUrl.toString(),
          verificationUrl: verificationUrl.toString(),
          pollIntervalMs: Number(begin.interval ?? 5) * 1_000,
          expiresInSeconds: Number(begin.expire_in ?? begin.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS),
        };
      },
      async poll(session, signal) {
        const brand = session.brand ?? 'feishu';
        const result = await postForm(
          feishuEndpoint(brand),
          { action: 'poll', device_code: session.opaqueToken ?? '' },
          signal,
        );
        if (typeof result.client_id === 'string' && typeof result.client_secret === 'string') {
          const botName = await fetchFeishuBotName(result.client_id, result.client_secret, brand, signal);
          return {
            status: 'confirmed',
            credential: {
              provider: 'feishu',
              appId: result.client_id,
              appSecret: result.client_secret,
              brand,
              ...(botName ? { botName } : {}),
            },
            identity: { id: result.client_id, ...(botName ? { displayName: botName } : {}) },
          };
        }
        switch (result.error) {
          case 'authorization_pending':
            return { status: 'pending' };
          case 'slow_down':
            return { status: 'slow_down' };
          case 'expired_token':
            return { status: 'expired' };
          case 'access_denied':
            return { status: 'denied' };
          default:
            throw new Error('Feishu registration returned an unknown status');
        }
      },
    },
    wecom: {
      async start(_input, signal) {
        const json = await getJson(
          `https://work.weixin.qq.com/ai/qc/generate?source=maka&plat=${platformCode()}`,
          signal,
          'WeCom QR generation',
        );
        if (typeof json.data?.scode !== 'string' || typeof json.data.auth_url !== 'string') {
          throw new Error('WeCom QR generation returned an invalid response');
        }
        return {
          opaqueToken: json.data.scode,
          qrValue: json.data.auth_url,
          verificationUrl: json.data.auth_url,
          pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
          expiresInSeconds: DEFAULT_EXPIRES_IN_SECONDS,
        };
      },
      async poll(session, signal) {
        const json = await getJson(
          `https://work.weixin.qq.com/ai/qc/query_result?scode=${encodeURIComponent(session.opaqueToken ?? '')}`,
          signal,
          'WeCom QR poll',
        );
        const status = json.data?.status;
        if (status === 'success') {
          const info = json.data?.bot_info;
          if (typeof info?.botid !== 'string' || typeof info.secret !== 'string') {
            throw new Error('WeCom registration returned incomplete credentials');
          }
          return {
            status: 'confirmed',
            credential: { provider: 'wecom', botId: info.botid, secret: info.secret },
            identity: { id: info.botid },
          };
        }
        // The endpoint is undocumented; the local expiry is the backstop for
        // a server that never says the code is dead.
        const terminal = wecomTerminalPollStatus(status);
        return terminal ? { status: terminal } : { status: 'pending' };
      },
    },
    wechat: {
      async start(_input, signal) {
        const payload = await ilinkGet('/ilink/bot/get_bot_qrcode?bot_type=3', {}, signal);
        if (typeof payload.ret === 'number' && payload.ret !== 0) {
          throw new Error(`QR fetch returned ret=${payload.ret}`);
        }
        const content = typeof payload.qrcode_img_content === 'string' ? payload.qrcode_img_content : '';
        const qrToken = typeof payload.qrcode === 'string' ? payload.qrcode : '';
        if (!content || !qrToken) throw new Error('QR fetch missing qrcode_img_content / qrcode');
        return {
          opaqueToken: qrToken,
          qrImage: content,
          pollIntervalMs: 2_500,
          expiresInSeconds: DEFAULT_EXPIRES_IN_SECONDS,
        };
      },
      async poll(session, signal) {
        if (!session.opaqueToken) throw new Error('qrToken required');
        const payload = await ilinkGet(
          `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(session.opaqueToken)}`,
          { 'iLink-App-ClientVersion': '1' },
          signal,
        );
        const status = payload.status ?? 'waiting';
        if (status === 'expired') return { status: 'expired' };
        if (status !== 'confirmed') return { status: 'pending' };
        const text = (value) => (typeof value === 'string' ? value : '');
        const credential = {
          provider: 'wechat',
          botToken: text(payload.bot_token),
          baseUrl: text(payload.baseurl) || ILINK_BASE_URL,
          botId: text(payload.ilink_bot_id),
          userId: text(payload.ilink_user_id),
        };
        return { status: 'confirmed', credential, identity: { id: credential.botId } };
      },
    },
    qq: {
      async start(_input, signal) {
        const decryptionKey = randomBytes(32).toString('base64');
        const json = await postQQBind('/lite/create_bind_task', { key: decryptionKey }, signal);
        const taskId = json.data?.task_id;
        if (typeof taskId !== 'string' || taskId.length === 0) {
          throw new Error('QQ bind task response is missing task_id');
        }
        const verificationUrl = new URL('/qqbot/openclaw/connect.html', QQ_BIND_BASE_URL);
        verificationUrl.searchParams.set('task_id', taskId);
        verificationUrl.searchParams.set('source', 'maka');
        verificationUrl.searchParams.set('_wv', '2');
        return {
          opaqueToken: JSON.stringify({ taskId, decryptionKey }),
          qrValue: verificationUrl.toString(),
          verificationUrl: verificationUrl.toString(),
          pollIntervalMs: 2_000,
          expiresInSeconds: DEFAULT_EXPIRES_IN_SECONDS,
        };
      },
      async poll(session, signal) {
        const { taskId, decryptionKey } = parseQQOpaqueToken(session.opaqueToken);
        const json = await postQQBind('/lite/poll_bind_result', { task_id: taskId }, signal);
        const status = json.data?.status;
        if (status === 3) return { status: 'expired' };
        if (status !== 2) return { status: 'pending' };
        const appId = json.data?.bot_appid;
        const encryptedSecret = json.data?.bot_encrypt_secret;
        if (
          (typeof appId !== 'string' && typeof appId !== 'number') ||
          typeof encryptedSecret !== 'string' ||
          encryptedSecret.length === 0
        ) {
          throw new Error('QQ bind result is missing bot credentials');
        }
        const credential = {
          provider: 'qq',
          appId: String(appId),
          appSecret: decryptQQBotSecret(encryptedSecret, decryptionKey),
        };
        return { status: 'confirmed', credential, identity: { id: credential.appId } };
      },
    },
  };
}

function parseQQOpaqueToken(value) {
  if (!value) throw new Error('QQ bind session is missing');
  const parsed = JSON.parse(value);
  if (typeof parsed.taskId !== 'string' || typeof parsed.decryptionKey !== 'string') {
    throw new Error('QQ bind session is invalid');
  }
  return parsed;
}

/**
 * QQ returns the AppSecret sealed with the key the task was created with:
 * AES-256-GCM, a 12-byte IV first and the 16-byte tag last.
 */
export function decryptQQBotSecret(encryptedSecret, decryptionKey) {
  const payload = Buffer.from(encryptedSecret, 'base64');
  const key = Buffer.from(decryptionKey, 'base64');
  if (key.length !== 32 || payload.length <= 28) {
    throw new Error('QQ bind result contains an invalid encrypted secret');
  }
  const iv = payload.subarray(0, 12);
  const authTag = payload.subarray(payload.length - 16);
  const ciphertext = payload.subarray(12, payload.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
