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
 * A Chrome DevTools Protocol client for the running dev app (#4109).
 *
 * Small on purpose: `/json/list` to find the renderer target, one WebSocket,
 * `Runtime.evaluate` and `Input.dispatchMouseEvent`. Nothing here is specific
 * to a measurement — the probes in this directory are.
 *
 * Clicks must go through `Input.dispatchMouseEvent`. A synthesised
 * `element.click()` does not produce the event sequence Astryx's SideNavItem
 * listens for, so the row never activates and the measurement silently
 * describes an app that did nothing.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

export const DEFAULT_PORT = 9334;

export async function targets(port = DEFAULT_PORT) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  return response.json();
}

export async function connectRenderer(port = DEFAULT_PORT, match = /index\.html|maka/i) {
  const list = await targets(port);
  const page = list.find(
    (target) => target.type === 'page' && (match.test(target.url) || match.test(target.title)),
  );
  if (!page) {
    const seen = list.map((target) => `${target.type} ${target.title} ${target.url}`).join('\n  ');
    throw new Error(`no renderer target on port ${port}. Saw:\n  ${seen}`);
  }
  return connect(page.webSocketDebuggerUrl);
}

export function connect(url) {
  const socket = new WebSocket(url, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
  let nextId = 0;
  const pending = new Map();
  const listeners = [];
  const ready = new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.id === undefined) {
      for (const listener of listeners) listener(message);
      return;
    }
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (!waiter) return;
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression, options = {}) => {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      ...options,
    });
    if (result.exceptionDetails) {
      throw new Error(
        JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails),
      );
    }
    return result.result.value;
  };

  return {
    socket,
    send,
    evaluate,
    on: (listener) => listeners.push(listener),
    ready,
    close: () => socket.close(),
  };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Click the nth Session row by real input events, at the centre of its box.
 *
 * Scoped to the rail and refused when the row is not on screen. A click at
 * coordinates outside the viewport lands on whatever is there instead — one of
 * them opened Settings mid-run and the measurement that followed described an
 * app that was not showing the rail at all.
 */
export async function clickSessionRow(client, index) {
  const box = JSON.parse(
    await client.evaluate(
      `(() => {
        const rail = document.querySelector('nav.maka-session-panel');
        if (!rail) throw new Error('the session rail is not mounted');
        const row = [...rail.querySelectorAll('[data-session-id]')][${index}];
        if (!row) throw new Error('no session row at index ${index}');
        const b = row.getBoundingClientRect();
        const x = b.x + b.width / 2;
        const y = b.y + b.height / 2;
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) {
          throw new Error('session row ${index} is off screen (' + x + ',' + y + ')');
        }
        return JSON.stringify({ x, y });
      })()`,
    ),
  );
  const point = {
    x: Math.round(box.x),
    y: Math.round(box.y),
    button: 'left',
    clickCount: 1,
    buttons: 1,
  };
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, buttons: 0 });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, buttons: 0 });
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
