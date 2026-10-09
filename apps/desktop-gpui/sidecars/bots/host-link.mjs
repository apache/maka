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

// The sidecar's connection to the local Runtime Host of its State Root.
//
// The client's windows start and keep the Host; the sidecar only connects,
// as a local owner, through the Host's published registration
// (`connectExistingRuntimeHost`, which writes nothing), and connects again
// with backoff whenever the connection ends. Each connection gets its own
// routing service, as each Desktop Host candidate gets its own
// `createBotIncomingMainService` (runtime-host-desktop-candidate.ts), so chat
// bindings start over with a new connection just as they do in Desktop.
//
// A bot message that arrives while no connection is up waits for the next
// one, as Desktop waits for a ready candidate
// (`handleBotIncomingMessage` in runtime-host-desktop-manager.ts).

/** How long a bot message waits for a Host connection before it is dropped. */
export const HOST_WAIT_TIMEOUT_MS = 30_000;

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 15_000;

export function reconnectDelay(failures) {
  if (failures <= 0) return 0;
  return Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(failures - 1, 16));
}

/**
 * @param {object} deps
 * @param {() => Promise<object>} deps.connect resolves to a
 *   `connectExistingRuntimeHost` result
 * @param {(connection: object) => object} deps.createIncoming a routing
 *   service for one connection
 * @param {(state: object) => void} deps.onState `{ state: 'connected', rootId,
 *   hostEpoch }` or `{ state: 'disconnected', reason }`
 * @param {(failures: number) => number} [deps.delay] backoff override for tests
 */
export function createHostLink(deps) {
  const delay = deps.delay ?? reconnectDelay;
  let current;
  let closed = false;
  let wake;
  let running;
  const waiters = new Set();

  function sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  async function run() {
    let failures = 0;
    while (!closed) {
      let result;
      try {
        result = await deps.connect();
      } catch (error) {
        result = { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
      }
      if (closed) {
        if (result.kind === 'connected') await result.connection.close().catch(() => undefined);
        break;
      }
      if (result.kind === 'connected') {
        failures = 0;
        const { connection } = result;
        const incoming = deps.createIncoming(connection);
        current = { connection, incoming };
        deps.onState({ state: 'connected', rootId: connection.rootId, hostEpoch: connection.hostEpoch });
        for (const waiter of waiters) waiter.resolve(current);
        waiters.clear();
        let reason = 'closed';
        await Promise.race([
          connection.closed.then(
            () => undefined,
            (error) => {
              reason = error instanceof Error ? error.message : String(error);
            },
          ),
          new Promise((resolve) => {
            wake = resolve;
          }),
        ]);
        current = undefined;
        // Desktop's candidate closes both together (`#close` in
        // runtime-host-desktop-candidate.ts): the routing service is marked
        // closed first, so a Turn that fails with the connection sends no
        // error notice to the chat.
        await Promise.allSettled([incoming.close(), connection.close()]);
        deps.onState({ state: 'disconnected', reason: closed ? 'stopped' : reason });
        continue;
      }
      failures += 1;
      deps.onState({ state: 'disconnected', reason: result.reason ?? result.kind });
      await sleep(delay(failures));
    }
  }

  return {
    start() {
      running ??= run();
      return running;
    },

    /** The live connection and its routing service, waiting for one if needed. */
    whenConnected(timeoutMs = HOST_WAIT_TIMEOUT_MS) {
      if (current) return Promise.resolve(current);
      if (closed) return Promise.reject(new Error('The bot sidecar is stopping'));
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error('Runtime Host is not connected'));
        }, timeoutMs);
        waiters.add(waiter);
      });
    },

    async handleBotIncomingMessage(message) {
      const { incoming } = await this.whenConnected();
      await incoming.handleBotIncomingMessage(message);
    },

    async close() {
      closed = true;
      for (const waiter of waiters) waiter.reject(new Error('The bot sidecar is stopping'));
      waiters.clear();
      wake?.();
      await running;
    },
  };
}
