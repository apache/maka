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

// Watches the Telegram Bot API traffic of the bridges without changing it.
//
// Telegram answers `getUpdates` with 409 Conflict when a second process polls
// the same bot token ("terminated by other getUpdates request") or when the
// bot has a webhook ("can't use getUpdates method while webhook is active").
// The bridge in `@maka/runtime/bots` (`pollTelegram` in telegram-bridge.ts)
// only waits five seconds and polls again, so two clients on one token take
// turns receiving messages and neither says so. The sidecar observes those
// answers on undici's diagnostics channels, which see every request the
// bridges make (`proxied-fetch.ts` fetches through undici) without touching
// them, and reports each conflict to `onConflict`.
//
// For tests only, `redirectTelegramApi` sends the requests meant for
// api.telegram.org to a loopback origin: the bridge has no setting for its
// API base URL (`telegramApi` in telegram-bridge.ts and `testTelegram` in
// bot-test.ts build `https://api.telegram.org/bot<token>/...` inline).

import diagnosticsChannel from 'node:diagnostics_channel';

export const TELEGRAM_API_ORIGIN = 'https://api.telegram.org';

/** Names the loopback origin that stands in for api.telegram.org in tests. */
export const TELEGRAM_API_ORIGIN_ENV = 'MAKA_BOTS_TELEGRAM_API_ORIGIN';

/** Bytes of a 409 answer kept to read Telegram's description from. */
const CONFLICT_BODY_MAX_BYTES = 4096;

/** The Bot API method a request path names: `/bot<token>/<method>`. */
export function telegramMethod(path) {
  if (typeof path !== 'string') return undefined;
  const match = /^\/bot[^/]+\/([A-Za-z]+)(?:[?#].*)?$/.exec(path);
  return match?.[1];
}

/**
 * The `kind` of a conflict from Telegram's description: `webhook` when the
 * bot has a webhook, else `polling` (another process polls the token).
 */
export function conflictKind(description) {
  return typeof description === 'string' && /webhook/i.test(description) ? 'webhook' : 'polling';
}

/**
 * Subscribes to undici's request channels and calls
 * `onConflict({ kind, description })` for every `getUpdates` that Telegram
 * (or the test origin) answers with 409. Returns the unsubscribe function.
 */
export function observeTelegramConflicts(onConflict, { origins = [TELEGRAM_API_ORIGIN] } = {}) {
  const watched = new Set(origins);
  const conflicts = new WeakMap();
  const isGetUpdates = (request) =>
    watched.has(originOf(request?.origin)) && telegramMethod(request?.path) === 'getUpdates';
  const onHeaders = ({ request, response }) => {
    if (response?.statusCode === 409 && isGetUpdates(request)) {
      conflicts.set(request, { chunks: [], size: 0 });
    }
  };
  const onChunk = ({ request, chunk }) => {
    const body = conflicts.get(request);
    if (!body || body.size >= CONFLICT_BODY_MAX_BYTES) return;
    const piece = Buffer.from(chunk).subarray(0, CONFLICT_BODY_MAX_BYTES - body.size);
    body.chunks.push(piece);
    body.size += piece.length;
  };
  const onEnd = ({ request }) => {
    const body = conflicts.get(request);
    if (!body) return;
    conflicts.delete(request);
    let description;
    try {
      const parsed = JSON.parse(Buffer.concat(body.chunks).toString('utf8'));
      if (typeof parsed?.description === 'string') description = parsed.description.slice(0, 200);
    } catch {
      // A truncated or non-JSON body still reports the conflict.
    }
    try {
      onConflict({ kind: conflictKind(description), ...(description ? { description } : {}) });
    } catch {
      // An observer must never fail a request.
    }
  };
  const subscriptions = [
    ['undici:request:headers', onHeaders],
    ['undici:request:bodyChunkReceived', onChunk],
    ['undici:request:trailers', onEnd],
  ];
  for (const [name, listener] of subscriptions) diagnosticsChannel.subscribe(name, listener);
  return () => {
    for (const [name, listener] of subscriptions) diagnosticsChannel.unsubscribe(name, listener);
  };
}

/**
 * Parses the test origin: plain HTTP on a loopback address only, so the
 * variable can never send a bot token off the machine.
 */
export function parseTestOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${TELEGRAM_API_ORIGIN_ENV} is not a URL`);
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'http:' || !loopback || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${TELEGRAM_API_ORIGIN_ENV} must be an http://127.0.0.1:<port> origin`);
  }
  return url.origin;
}

/**
 * Routes the requests meant for api.telegram.org to `origin` through
 * undici's global dispatcher, which the bridges use when no proxy is active.
 */
export function redirectTelegramApi(undici, origin) {
  const redirect = (dispatch) => (options, handler) =>
    dispatch(
      originOf(options.origin) === TELEGRAM_API_ORIGIN ? { ...options, origin } : options,
      handler,
    );
  undici.setGlobalDispatcher(undici.getGlobalDispatcher().compose(redirect));
}

function originOf(value) {
  if (typeof value === 'string') {
    try {
      return new URL(value).origin;
    } catch {
      return undefined;
    }
  }
  return value?.origin;
}
