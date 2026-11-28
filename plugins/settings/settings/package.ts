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
import { empty, one, native, localizePackage, localizedTitle } from '../../shared/package.js';

export default localizePackage({
  schemaVersion: 1,
  id: 'maka.agent.settings',
  displayName: 'Settings',
  description: 'Configure connections, models, preferences and installed UI.',
  application: {
    host: native(sdk.nativeImplementations.settings),
    ui: {
      module: 'ui.js',
      configuration: empty,
      imports: {
        settings: one(sdk.contracts.settings),
        authentication: one(sdk.contracts.settingsAuthentication),
        setup: one(sdk.contracts.settingsSetup),
        agent: one(sdk.contracts.agent),
        skills: { contract: sdk.contracts.skillLibrary, cardinality: { kind: 'optional' } },
        web: { contract: sdk.contracts.workspaceWeb, cardinality: { kind: 'optional' } },
        management: one(sdk.contracts.deploymentManager),
        receipts: one(sdk.contracts.receiptReader),
      },
      contributions: {
        Settings: { kind: 'view', contract: 'maka.settings' },
        general: {
          kind: 'settings',
          title: localizedTitle('General'),
        },
        connections: {
          kind: 'settings',
          title: localizedTitle('Models'),
        },
        subagents: {
          kind: 'settings',
          title: localizedTitle('Subagents'),
        },
        skills: {
          kind: 'settings',
          title: localizedTitle('Skills'),
        },
        mcp: {
          kind: 'settings',
          title: localizedTitle('MCP servers'),
        },
        'web-search': {
          kind: 'settings',
          title: localizedTitle('Web search'),
        },
        network: {
          kind: 'settings',
          title: localizedTitle('Network'),
        },
        'system-permissions': {
          kind: 'settings',
          title: localizedTitle('System permissions'),
        },
        'remote-access': {
          kind: 'settings',
          title: localizedTitle('Remote Access'),
        },
        plugins: {
          kind: 'settings',
          title: localizedTitle('Installed plugins'),
        },
        marketplace: {
          kind: 'settings',
          title: localizedTitle('Plugin marketplace'),
        },
        appearanceTextSize: {
          kind: 'command',
          title: localizedTitle('Change text size'),
        },
        uiScaleReset: {
          kind: 'command',
          title: localizedTitle('Reset interface scale to 100%'),
          description: localizedTitle('Interface scale'),
          order: 0,
          shortcut: 'mod+alt+0',
          trigger: 'reset-scale',
        },
      },
    },
  },
});
