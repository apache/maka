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

import * as sdk from '../../../packages/plugin-sdk/src/index.js';
import { one, native } from '../../shared/package.js';
export default {
  schemaVersion: 1,
  id: 'maka.agent.gateway',
  displayName: 'Host connection',
  description: 'Connect the app to the assistant running on the host.',
  localizations: {
    'zh-CN': { displayName: '主机连接', description: '将应用连接到主机上运行的助手。' },
  },
  application: {
    host: {
      ...native(sdk.nativeImplementations.gateway),
      imports: {
        agent: one(sdk.contracts.agent),
        hostLogs: { contract: sdk.contracts.hostLogs, cardinality: { kind: 'optional' } },
        coordinator: { contract: sdk.contracts.agent, cardinality: { kind: 'optional' } },
        workhub: {
          contract: sdk.contracts.workhubCoordinator,
          cardinality: { kind: 'optional' },
        },
        coordinatorTerminal: {
          contract: sdk.contracts.terminal,
          cardinality: { kind: 'optional' },
        },
        terminal: { contract: sdk.contracts.terminal, cardinality: { kind: 'optional' } },
        jev: { contract: sdk.contracts.workspaceJev, cardinality: { kind: 'optional' } },
        web: { contract: sdk.contracts.workspaceWeb, cardinality: { kind: 'optional' } },
        skills: { contract: sdk.contracts.skillLibrary, cardinality: { kind: 'optional' } },
        settings: one(sdk.contracts.settings),
        authentication: one(sdk.contracts.settingsAuthentication),
        setup: one(sdk.contracts.settingsSetup),
      },
    },
  },
};
