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
import { empty, one, native } from '../../shared/package.js';

export default {
  schemaVersion: 1,
  id: 'maka.agent.settings',
  displayName: 'Settings',
  description: 'Configure connections, models, preferences and installed UI.',
  localizations: {
    'zh-CN': { displayName: '设置', description: '配置连接、模型、偏好与已安装界面。' },
  },
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
        management: one(sdk.contracts.deploymentManager),
        receipts: one(sdk.contracts.receiptReader),
      },
      contributions: {
        Settings: { kind: 'view', contract: 'maka.settings' },
        general: {
          kind: 'settings',
          title: { fallback: 'General', translations: { 'zh-CN': '常规', 'zh-TW': '一般' } },
        },
        connections: {
          kind: 'settings',
          title: {
            fallback: 'Connections & models',
            translations: { 'zh-CN': '连接与模型', 'zh-TW': '連線與模型' },
          },
        },
        network: {
          kind: 'settings',
          title: { fallback: 'Network', translations: { 'zh-CN': '网络', 'zh-TW': '網路' } },
        },
        plugins: {
          kind: 'settings',
          title: { fallback: 'Plugins', translations: { 'zh-CN': '插件', 'zh-TW': '外掛' } },
        },
        appearanceTextSize: {
          kind: 'command',
          title: { fallback: 'Change text size', translations: { 'zh-CN': '更改文字大小' } },
        },
        uiScaleReset: {
          kind: 'command',
          title: {
            fallback: 'Reset interface scale to 100%',
            translations: { 'zh-CN': '重置界面缩放为 100%', 'zh-TW': '重設介面縮放為 100%' },
          },
          description: {
            fallback: 'Interface scale',
            translations: { 'zh-CN': '界面缩放', 'zh-TW': '介面縮放' },
          },
          order: 0,
          shortcut: 'mod+alt+0',
          trigger: 'reset-scale',
        },
      },
    },
  },
};
