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

import type { MakaBridge } from '../../../preload/bridge-contract.js';
import type {
  MakaClientProductEventMap,
  MakaClientProductEventName,
  MakaClientProductEventOptions,
} from '@maka/core/client-plugin-bridge';
import type { ClientPluginServices } from '../../features/client-plugins/index.js';

export type DesktopClientPluginBridge = Pick<MakaBridge, 'clientPlugins' | 'sessions' | 'graphs'>;

/** The only Desktop environment adapter for the Client Plugin feature. */
export function createDesktopClientPluginServices(
  bridge: DesktopClientPluginBridge = window.maka,
): ClientPluginServices {
  return {
    clientPlugins: {
      snapshot: () => bridge.clientPlugins.snapshot(),
      remote: {
        call: (input) => bridge.clientPlugins.remoteCall(input),
        open: (input) => bridge.clientPlugins.remoteStreamOpen(input),
        next: (input) => bridge.clientPlugins.remoteStreamNext(input),
        close: (input) => bridge.clientPlugins.remoteStreamClose(input),
      },
      productEvents: {
        subscribe: <Name extends MakaClientProductEventName>(
          name: Name,
          options: MakaClientProductEventOptions<Name>,
          listener: (event: MakaClientProductEventMap[Name]) => void,
        ): (() => void) => {
          if (name === 'session.changed') {
            return bridge.sessions.subscribeChanges(
              listener as (event: MakaClientProductEventMap['session.changed']) => void,
            );
          }
          const sessionId = options.sessionId;
          if (!sessionId) throw new Error(`${name} requires a Session id`);
          if (name === 'agent.graph.changed') {
            return bridge.graphs.subscribe(sessionId, () =>
              listener({ sessionId } as MakaClientProductEventMap[Name]),
            );
          }
          return bridge.sessions.subscribeEvents(sessionId, (event) => {
            if (name === 'tool.activity' && !event.type.startsWith('tool_')) return;
            listener({ sessionId, event } as MakaClientProductEventMap[Name]);
          });
        },
      },
    },
  };
}
