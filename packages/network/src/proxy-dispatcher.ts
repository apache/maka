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
import { isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { buildProxyUrl } from './proxy-parser.js';
import type { ProxySettings } from '@maka/core/settings/network-settings';

export function buildProxyDispatcher(proxy: ProxySettings): Agent | ProxyAgent {
  if (proxy.type === 'socks5') return buildSocks5Dispatcher(proxy);
  return new ProxyAgent(buildProxyUrl(proxy));
}

function buildSocks5Dispatcher(proxy: ProxySettings): Agent {
  const connector = buildConnector({ allowH2: false });
  void connector;

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

      SocksClient.createConnection({
        proxy: {
          host: proxy.host,
          port: proxy.port,
          type: 5,
          userId: proxy.username,
          password: proxy.password,
        },
        command: 'connect',
        destination: { host, port },
      })
        .then(({ socket }) => {
          socket.setKeepAlive(true, 60_000);
          if (connectionOptions.protocol === 'https:') {
            const servername = connectionOptions.servername ?? (isIP(host) ? undefined : host);
            const tlsSocket = tlsConnect({
              ...(opts as object),
              servername,
              host,
              port,
              socket,
            });
            tlsSocket.once('error', (error) => {
              socket.destroy();
              callback(error, null);
            });
            tlsSocket.once('secureConnect', () => {
              tlsSocket.setKeepAlive(true, 60_000);
              callback(null, tlsSocket);
            });
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
