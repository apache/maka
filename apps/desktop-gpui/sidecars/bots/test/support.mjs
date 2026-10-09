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

// Shared pieces of the sidecar's tests. They run against the real Maka
// modules of the checkout in $MAKA_REPO (default ~/code/maka-pin), built, so
// the routing is tested with the helpers it runs with:
//
//   MAKA_REPO=~/code/maka-pin node --test 'sidecars/bots/test/*.test.mjs'

import os from 'node:os';
import path from 'node:path';
import { loadMaka } from '../maka.mjs';

export const checkout = process.env.MAKA_REPO || path.join(os.homedir(), 'code', 'maka-pin');

let loaded;
export function maka() {
  loaded ??= loadMaka(checkout);
  return loaded;
}

/** A `BotRegistry` stand-in that records what the routing sends. */
export function fakeRegistry() {
  const sent = [];
  const typing = [];
  return {
    sent,
    typing,
    async sendMessage(platform, chatId, text, options) {
      sent.push({ platform, chatId, text, options });
      return `sent-${sent.length}`;
    },
    startReplyStream() {
      return null;
    },
    async sendTypingIndicator(platform, chatId) {
      typing.push({ platform, chatId });
      return true;
    },
  };
}

/**
 * A `BotSessionAdapter` stand-in: every Turn completes with `reply(text)` at
 * once, and the calls are recorded.
 */
export function fakeSessions({ reply = (text) => `echo ${text}` } = {}) {
  const created = [];
  const turns = [];
  const prepared = [];
  let unavailable = new Set();
  return {
    created,
    turns,
    prepared,
    makeUnavailable(sessionId) {
      unavailable = new Set([...unavailable, sessionId]);
    },
    async createSession(input) {
      const sessionId = `session-${created.length + 1}`;
      created.push({ ...input, sessionId });
      return sessionId;
    },
    async prepareSession(sessionId) {
      prepared.push(sessionId);
      if (unavailable.has(sessionId)) {
        const { BotSessionUnavailableError } = await import('../session-adapter.mjs');
        throw new BotSessionUnavailableError(`Bot Session is unavailable: ${sessionId}`);
      }
      return 'ready';
    },
    async runTurn({ sessionId, turnId, text, onReplySnapshot }) {
      turns.push({ sessionId, turnId, text });
      const answer = reply(text);
      onReplySnapshot?.(answer);
      return { kind: 'completed', text: answer };
    },
  };
}

/** A Telegram direct-chat text message as the bridge emits it. */
export function botMessage({ text, sourceMessageId, chatId = '7001', ...rest }) {
  return {
    platform: 'telegram',
    userId: chatId,
    userName: 'test_user',
    chatId,
    isGroup: false,
    text,
    sourceMessageId,
    receivedAt: 0,
    ...rest,
  };
}
