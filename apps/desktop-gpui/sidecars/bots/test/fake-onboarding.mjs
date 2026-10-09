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

// A fake of the onboarding providers' endpoints on a loopback port, for
// `onboarding.test.mjs`.
//
// A request for `https://<host>/<path>` arrives as `/<host>/<path>` through
// `fetchThrough`. Each route answers from a script the test sets with
// `answer(route, ...answers)`: the answers go out in order and the last one
// repeats. An answer is a JSON body, `{ httpStatus, body }`, or a function of
// the request (`{ method, path, query, headers, body }`) returning either.

import http from 'node:http';

export async function startFakeOnboarding() {
  const scripts = new Map();
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    const url = new URL(request.url, 'http://fake');
    const route = `${request.method} ${url.pathname}`;
    const type = request.headers['content-type'] ?? '';
    const body = !text
      ? undefined
      : type.includes('application/x-www-form-urlencoded')
        ? Object.fromEntries(new URLSearchParams(text))
        : JSON.parse(text);
    const call = {
      route,
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: request.headers,
      body,
    };
    calls.push(call);
    const script = scripts.get(route);
    let answer = script ? (script.length > 1 ? script.shift() : script[0]) : { httpStatus: 404, body: {} };
    if (typeof answer === 'function') answer = answer(call);
    const { httpStatus = 200, body: payload = answer } =
      answer && typeof answer === 'object' && 'httpStatus' in answer ? answer : { body: answer };
    response.writeHead(httpStatus, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    calls,
    /** The calls of one route (`POST /oapi.dingtalk.com/app/registration/poll`). */
    callsOf(route) {
      return calls.filter((call) => call.route === route);
    },
    answer(route, ...answers) {
      scripts.set(route, answers);
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      });
    },
  };
}

/** `proxiedFetch`, with every provider URL sent to the fake at `origin`. */
export function fetchThrough(origin, proxiedFetch) {
  return (url, init) => {
    const target = new URL(url);
    return proxiedFetch(`${origin}/${target.host}${target.pathname}${target.search}`, init);
  };
}
