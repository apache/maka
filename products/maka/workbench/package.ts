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

import { contracts } from '../../../packages/plugin-sdk/src/index.js';
import { empty, one } from '../../../plugins/shared/package.js';

export default {
  schemaVersion: 1,
  id: 'maka.workbench',
  displayName: 'Maka',
  description: 'Conversations, tools and settings in the Maka workbench.',
  localizations: {
    'zh-CN': { displayName: 'Maka', description: '在 Maka 工作台中管理对话、工具和设置。' },
  },
  application: {
    ui: {
      module: 'app/App.js',
      configuration: empty,
      imports: {
        agent: one(contracts.agent),
        management: one(contracts.deploymentManager),
        settings: one(contracts.settings),
        authentication: one(contracts.settingsAuthentication),
        setup: one(contracts.settingsSetup),
        receipts: one(contracts.receiptReader),
        skillOutcomes: one(contracts.skillOutcomes),
        hostLogs: one(contracts.hostLogs),
        terminal: { contract: contracts.terminal, cardinality: { kind: 'optional' } },
        coordinator: { contract: contracts.agent, cardinality: { kind: 'optional' } },
        workhub: { contract: contracts.workhubCoordinator, cardinality: { kind: 'optional' } },
        coordinatorTerminal: { contract: contracts.terminal, cardinality: { kind: 'optional' } },
        jev: { contract: contracts.workspaceJev, cardinality: { kind: 'optional' } },
        web: { contract: contracts.workspaceWeb, cardinality: { kind: 'optional' } },
        skills: { contract: contracts.skillLibrary, cardinality: { kind: 'optional' } },
      },
      contributions: { root: { kind: 'root' } },
    },
  },
};
