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

/**
 * PR-BOT-WECHAT-QR-MODAL-0 (WAWQAQ msg `10ec1fbe`): WeChat personal-account
 * scan-login via the iLink ClawBot endpoints. The reference design uses
 * an external service hosted by Tencent that returns QR payload content
 * + a token. The upstream client renders that payload into a local PNG
 * data URL before handing it to the renderer; the user scans the QR with
 * WeChat on their phone; we poll the status endpoint for `confirmed` /
 * `expired`.
 *
 * Endpoints (reverse-engineered from the upstream desktop client at
 * external reference main.js:41518-41600):
 *   GET https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3
 *     → { ret, qrcode_img_content, qrcode }
 *   GET https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=<token>
 *     → { status: 'waiting' | 'confirmed' | 'expired',
 *         bot_token, baseurl, ilink_bot_id, ilink_user_id }
 *
 * Both endpoints require an `X-WECHAT-UIN` header carrying a base64-
 * encoded random uint32. The upstream client regenerates this per
 * request; we do the same.
 *
 * Boundaries:
 *   - Module is main-process only. The renderer never sees raw HTTP
 *     bodies; it only sees the structured result envelope returned by
 *     the IPC handler.
 *   - No persistence happens here. The caller (main.ts IPC handler)
 *     decides whether to write the resulting bot_token into
 *     `BotChannelSettings`.
 *   - Network requests respect any configured Maka network proxy
 *     because they go through `globalThis.fetch`, which Electron wires
 *     to the session proxy.
 */

import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
const QR_FETCH_TIMEOUT_MS = 15_000;
const QR_STATUS_TIMEOUT_MS = 15_000;

export interface WeChatQrcode {
  /** PNG data URL the renderer can render directly in an <img>. */
  qrcodeUrl: string;
  /** Opaque session token the status poller passes back. */
  qrToken: string;
}

export type WeChatQrcodeStatus =
  | { status: 'waiting' }
  | { status: 'expired' }
  | {
      status: 'confirmed';
      credentials: {
        botToken: string;
        baseUrl: string;
        botId: string;
        userId: string;
      };
    };

function wechatUinHeader(): string {
  // 4 random bytes → little-endian uint32 → ASCII digits → base64.
  // Same shape as the upstream client uses.
  const value = randomBytes(4).readUInt32LE(0);
  return Buffer.from(String(value), 'utf-8').toString('base64');
}

const require = createRequire(import.meta.url);

async function renderWeChatQrcode(raw: string): Promise<string> {
  if (raw.startsWith('data:image/')) return raw;
  if (looksLikeBase64Png(raw)) return `data:image/png;base64,${raw}`;
  const qrcode = require('qrcode') as {
    toDataURL(input: string, options: Record<string, unknown>): Promise<string>;
  };
  return qrcode.toDataURL(raw, {
    width: 256,
    margin: 2,
    errorCorrectionLevel: 'M',
  });
}

function looksLikeBase64Png(value: string): boolean {
  return value.length > 80 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

async function ilinkGet<T>(
  path: string,
  timeoutMs: number,
  extraHeaders: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<T> {
  // PR1197 review (P2-10): compose any caller-supplied session signal with the
  // internal timeout so cancelling the onboarding session aborts the in-flight
  // request instead of leaking it until the timeout fires.
  const composed = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const response = await fetch(`${ILINK_BASE_URL}${path}`, {
    method: 'GET',
    headers: { 'X-WECHAT-UIN': wechatUinHeader(), ...extraHeaders },
    signal: composed,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Non-JSON response: ${text.slice(0, 200)}`);
  }
}

export async function fetchWeChatQrcode(signal?: AbortSignal): Promise<WeChatQrcode> {
  const payload = await ilinkGet<{ ret?: number; qrcode_img_content?: string; qrcode?: string }>(
    '/ilink/bot/get_bot_qrcode?bot_type=3',
    QR_FETCH_TIMEOUT_MS,
    {},
    signal,
  );
  if (typeof payload.ret === 'number' && payload.ret !== 0) {
    throw new Error(`QR fetch returned ret=${payload.ret}`);
  }
  const qrcodeContent = typeof payload.qrcode_img_content === 'string' ? payload.qrcode_img_content : '';
  const qrToken = typeof payload.qrcode === 'string' ? payload.qrcode : '';
  if (!qrcodeContent || !qrToken) {
    throw new Error('QR fetch missing qrcode_img_content / qrcode');
  }
  return { qrcodeUrl: await renderWeChatQrcode(qrcodeContent), qrToken };
}

export async function pollWeChatQrcodeStatus(qrToken: string, signal?: AbortSignal): Promise<WeChatQrcodeStatus> {
  if (!qrToken) throw new Error('qrToken required');
  const payload = await ilinkGet<{
    status?: string;
    bot_token?: string;
    baseurl?: string;
    ilink_bot_id?: string;
    ilink_user_id?: string;
  }>(
    `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrToken)}`,
    QR_STATUS_TIMEOUT_MS,
    { 'iLink-App-ClientVersion': '1' },
    signal,
  );
  const status = payload.status ?? 'waiting';
  if (status === 'confirmed') {
    return {
      status: 'confirmed',
      credentials: {
        botToken: typeof payload.bot_token === 'string' ? payload.bot_token : '',
        baseUrl: typeof payload.baseurl === 'string' && payload.baseurl ? payload.baseurl : ILINK_BASE_URL,
        botId: typeof payload.ilink_bot_id === 'string' ? payload.ilink_bot_id : '',
        userId: typeof payload.ilink_user_id === 'string' ? payload.ilink_user_id : '',
      },
    };
  }
  if (status === 'expired') return { status: 'expired' };
  return { status: 'waiting' };
}
