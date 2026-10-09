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

// A fake Telegram Bot API on a loopback port, for the sidecar's tests and the
// live test in crates/bots/tests/real_telegram.rs.
//
// It answers the methods the Telegram bridge of `@maka/runtime/bots` calls
// (getMe, getUpdates as a long poll, sendMessage, sendMessageDraft,
// editMessageText, sendChatAction, deleteMessage) and records every call.
// Tests drive it in process through `startFakeTelegram`, or over HTTP when it
// runs on its own:
//
//   node fake-telegram.mjs      # prints {"origin":"http://127.0.0.1:<port>"}
//
//   POST /_test/updates   {"message": {...}}  queues one update
//   POST /_test/conflict  {"on": true}        answers getUpdates with 409
//   GET  /_test/calls                         every call so far, in order
//
// It exits when stdin closes.

import http from 'node:http';
import { pathToFileURL } from 'node:url';

const MAX_POLL_SECONDS = 30;

export const FAKE_BOT = { id: 4242, is_bot: true, first_name: 'Maka Test', username: 'maka_test_bot' };

export const CONFLICT_DESCRIPTION =
  'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running';

export async function startFakeTelegram({ port = 0 } = {}) {
  const updates = [];
  const calls = [];
  const pollers = new Set();
  let nextUpdateId = 1;
  let nextMessageId = 1000;
  let conflict = false;

  const wakePollers = () => {
    for (const wake of pollers) wake();
    pollers.clear();
  };

  const enqueue = (message) => {
    updates.push({ update_id: nextUpdateId++, message });
    wakePollers();
  };

  const server = http.createServer(async (request, response) => {
    const body = await readBody(request);
    const reply = (status, value) => {
      const text = JSON.stringify(value);
      response.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(text),
      });
      response.end(text);
    };
    const url = new URL(request.url, 'http://fake');
    if (url.pathname === '/_test/updates' && request.method === 'POST') {
      enqueue(body.message);
      return reply(200, { ok: true });
    }
    if (url.pathname === '/_test/conflict' && request.method === 'POST') {
      conflict = body.on === true;
      wakePollers();
      return reply(200, { ok: true });
    }
    if (url.pathname === '/_test/calls') return reply(200, calls);

    const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(url.pathname);
    if (!match) return reply(404, { ok: false, error_code: 404, description: 'Not Found' });
    const [, token, method] = match;
    calls.push({ method, body });
    if (token === 'rejected') {
      return reply(401, { ok: false, error_code: 401, description: 'Unauthorized' });
    }
    switch (method) {
      case 'getMe':
        return reply(200, { ok: true, result: FAKE_BOT });
      case 'getUpdates': {
        const offset = Number(body.offset ?? 0);
        const deadline = Date.now() + Math.min(Number(body.timeout ?? 0), MAX_POLL_SECONDS) * 1000;
        for (;;) {
          if (conflict) {
            return reply(409, { ok: false, error_code: 409, description: CONFLICT_DESCRIPTION });
          }
          const pending = updates.filter((update) => update.update_id >= offset);
          const remaining = deadline - Date.now();
          if (pending.length > 0 || remaining <= 0) return reply(200, { ok: true, result: pending });
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, remaining);
            const wake = () => {
              clearTimeout(timer);
              resolve();
            };
            pollers.add(wake);
            // A poller that gave up (the bridge stopped) closes its socket.
            response.once('close', wake);
          });
          if (response.destroyed) return;
        }
      }
      case 'sendMessage':
      case 'editMessageText': {
        const messageId = nextMessageId++;
        return reply(200, {
          ok: true,
          result: { message_id: messageId, chat: { id: Number(body.chat_id) }, text: body.text },
        });
      }
      case 'sendMessageDraft':
      case 'sendChatAction':
      case 'deleteMessage':
        return reply(200, { ok: true, result: true });
      default:
        return reply(404, { ok: false, error_code: 404, description: 'Not Found: method not found' });
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    calls,
    enqueue,
    setConflict(on) {
      conflict = on;
      wakePollers();
    },
    close() {
      wakePollers();
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

/** A private-chat text message from `user`, as Telegram delivers it in an update. */
export function privateMessage({ messageId, chatId = 7001, userId = 7001, text }) {
  return {
    message_id: messageId,
    from: { id: userId, is_bot: false, first_name: 'Test', username: 'test_user' },
    chat: { id: chatId, type: 'private' },
    date: Math.floor(Date.now() / 1000),
    text,
  };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const fake = await startFakeTelegram();
  process.stdout.write(`${JSON.stringify({ origin: fake.origin })}\n`);
  process.stdin.resume();
  process.stdin.on('close', () => void fake.close().finally(() => process.exit(0)));
  process.on('SIGTERM', () => void fake.close().finally(() => process.exit(0)));
}
