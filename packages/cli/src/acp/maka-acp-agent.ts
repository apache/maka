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

import { agent, methods, type AgentApp } from '@agentclientprotocol/sdk';
import type { AcpSessionRegistry } from './session-registry.js';

export interface MakaAcpAgentOptions {
  readonly version: string;
  readonly sessionRegistry: Pick<
    AcpSessionRegistry,
    'create' | 'list' | 'setConfigOption' | 'prompt' | 'cancel' | 'close'
  >;
}

export function createMakaAcpAgent(options: MakaAcpAgentOptions): AgentApp {
  return agent({ name: 'maka' })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: 1,
      agentCapabilities: { sessionCapabilities: { list: {}, close: {} } },
      authMethods: [],
      agentInfo: { name: 'maka', title: 'Maka', version: options.version },
    }))
    .onRequest(methods.agent.session.new, ({ params }) => options.sessionRegistry.create(params))
    .onRequest(methods.agent.session.list, ({ params }) => options.sessionRegistry.list(params))
    .onRequest(methods.agent.session.setConfigOption, ({ params }) =>
      options.sessionRegistry.setConfigOption(params),
    )
    .onRequest(methods.agent.session.prompt, ({ params, signal, client }) =>
      options.sessionRegistry.prompt(params, {
        signal,
        notify: (notification) => client.notify(methods.client.session.update, notification),
      }),
    )
    .onNotification(methods.agent.session.cancel, ({ params }) =>
      options.sessionRegistry.cancel(params),
    )
    .onRequest(methods.agent.session.close, ({ params }) => options.sessionRegistry.close(params));
}
