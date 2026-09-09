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

import { Agent, ProxyAgent, buildConnector } from 'undici';
import { SocksClient } from 'socks';
import { Socket } from 'node:net';
import { once } from 'node:events';
import { buildProxyUrl } from './proxy-parser.js';
import type { ProxySettings } from '@maka/core/settings/network-settings';

export function buildProxyDispatcher(
  proxy: ProxySettings,
  signal: AbortSignal,
): Agent | ProxyAgent {
  if (proxy.type === 'socks5') return buildSocks5Dispatcher(proxy, signal);
  const connectOptions = { signal } as buildConnector.BuildOptions;
  return new ProxyAgent({
    uri: buildProxyUrl(proxy),
    proxyTls: connectOptions,
    requestTls: connectOptions,
  });
}

function buildSocks5Dispatcher(proxy: ProxySettings, signal: AbortSignal): Agent {
  const connector = buildConnector({ allowH2: false, signal });

  return new Agent({
    connect: (opts, callback) => {
      const connectionOptions = opts as {
        hostname?: string;
        host?: string;
        port?: number | string;
        protocol?: string;
        servername?: string;
      };
      const host = connectionOptions.hostname ?? connectionOptions.host;
      if (!host) {
        callback(new Error('Missing destination host'), null);
        return;
      }

      const port =
        typeof connectionOptions.port === 'number'
          ? connectionOptions.port
          : Number(connectionOptions.port) || (connectionOptions.protocol === 'https:' ? 443 : 80);

      connectSocksProxy(proxy, host, port, signal)
        .then((socket) => {
          socket.setKeepAlive(true, 60_000);
          if (connectionOptions.protocol === 'https:') {
            // Use Undici's bounded, single-callback TLS connector for the
            // tunnel too, rather than leaving a custom handshake unowned.
            connector({ ...opts, httpSocket: socket }, callback);
            return;
          }
          callback(null, socket);
        })
        .catch((error: unknown) =>
          callback(error instanceof Error ? error : new Error(String(error)), null),
        );
    },
  });
}

async function connectSocksProxy(
  proxy: ProxySettings,
  host: string,
  port: number,
  signal: AbortSignal,
): Promise<Socket> {
  // SOCKS creates an unabortable Socket internally. Supply our own connected
  // socket so close can interrupt TCP setup, SOCKS negotiation and the tunnel.
  const socket = new Socket({ signal });
  const onTimeout = () => socket.destroy(new Error('SOCKS proxy connection timed out'));
  socket.setTimeout(30_000, onTimeout);
  try {
    socket.connect({ host: proxy.host, port: proxy.port });
    await once(socket, 'connect');
    await SocksClient.createConnection({
      proxy: {
        host: proxy.host,
        port: proxy.port,
        type: 5,
        userId: proxy.username,
        password: proxy.password,
      },
      command: 'connect',
      destination: { host, port },
      existing_socket: socket,
    });
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    socket.setTimeout(0);
    socket.off('timeout', onTimeout);
  }
}
