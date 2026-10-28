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
import { one } from '../../shared/package.js';

const target = {
  type: 'object',
  properties: {
    path: { type: 'array', items: { type: 'string' }, minItems: 1 },
    id: { type: 'string', minLength: 1 },
  },
  required: ['path', 'id'],
  additionalProperties: false,
};

export default {
  schemaVersion: 1,
  id: 'maka.conversations',
  displayName: 'Conversations',
  description: 'Browse conversations, read history and coordinate session work.',
  localizations: {
    'zh-CN': { displayName: '会话', description: '浏览会话、阅读历史并协调会话任务。' },
  },
  application: {
    ui: {
      module: 'ui/index.js',
      configuration: {
        type: 'object',
        properties: { composer: target, workspace: target, settings: target },
        required: ['composer', 'workspace', 'settings'],
        additionalProperties: false,
      },
      imports: {
        agent: one(contracts.agent),
        settings: one(contracts.settings),
        authentication: one(contracts.settingsAuthentication),
        setup: one(contracts.settingsSetup),
        management: one(contracts.deploymentManager),
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
      contributions: {
        navigation: {
          kind: 'view',
          contract: 'maka.conversations.navigation',
        },
        session: {
          kind: 'view',
          contract: 'maka.conversations.session',
        },
        preview: {
          kind: 'view',
          contract: 'maka.conversations.preview',
        },
        commands: {
          kind: 'command',
          title: {
            fallback: 'Commands',
            translations: {
              'zh-CN': '命令',
            },
          },
        },
        browse: {
          kind: 'command',
          title: {
            fallback: 'Browse sessions',
            translations: {
              'zh-CN': '浏览会话',
            },
          },
        },
        sessions: {
          kind: 'command',
          title: { fallback: 'Sessions', translations: { 'zh-CN': '对话', 'zh-TW': '對話' } },
          description: {
            fallback: 'Resume a conversation',
            translations: { 'zh-CN': '继续对话', 'zh-TW': '繼續對話' },
          },
          order: 10,
          shortcut: 'mod+o',
          trigger: 'resume',
        },
        'new': {
          kind: 'command',
          title: {
            fallback: 'New conversation',
            translations: { 'zh-CN': '新建对话', 'zh-TW': '新增對話' },
          },
          description: {
            fallback: 'A fresh start in your workspace',
            translations: { 'zh-CN': '在工作区中开启新对话', 'zh-TW': '在工作區中開啟新對話' },
          },
          order: 20,
          shortcut: 'mod+n',
          trigger: 'new',
        },
        workspace: {
          kind: 'command',
          title: {
            fallback: 'Choose workspace',
            translations: { 'zh-CN': '选择工作区', 'zh-TW': '選擇工作區' },
          },
          description: {
            fallback: 'Start a conversation in another folder',
            translations: { 'zh-CN': '在其他文件夹中开始对话', 'zh-TW': '在其他資料夾中開始對話' },
          },
          order: 30,
          trigger: 'workspace',
        },
        models: {
          kind: 'command',
          title: { fallback: 'Models', translations: { 'zh-CN': '模型', 'zh-TW': '模型' } },
          description: {
            fallback: 'Choose the model for this conversation',
            translations: { 'zh-CN': '为此对话选择模型', 'zh-TW': '為此對話選擇模型' },
          },
          order: 40,
          shortcut: 'mod+g',
          trigger: 'model',
        },
        settings: {
          kind: 'command',
          title: {
            fallback: 'Connections & models',
            translations: { 'zh-CN': '连接与模型', 'zh-TW': '連線與模型' },
          },
          description: {
            fallback: 'Add connections, API keys and models',
            translations: {
              'zh-CN': '添加连接、API 密钥和模型',
              'zh-TW': '新增連線、API 金鑰和模型',
            },
          },
          order: 50,
          trigger: 'settings',
        },
        files: {
          kind: 'command',
          title: { fallback: 'Files', translations: { 'zh-CN': '文件', 'zh-TW': '檔案' } },
          description: {
            fallback: 'Browse workspace files and current changes',
            translations: {
              'zh-CN': '浏览工作区文件和当前更改',
              'zh-TW': '瀏覽工作區檔案和目前變更',
            },
          },
          order: 60,
          trigger: 'files',
        },
        compact: {
          kind: 'command',
          title: {
            fallback: 'Compact conversation',
            translations: { 'zh-CN': '压缩对话上下文', 'zh-TW': '壓縮對話上下文' },
          },
          description: {
            fallback: 'Summarize context for the next request',
            translations: {
              'zh-CN': '为下一次请求整理上下文摘要',
              'zh-TW': '為下一次請求整理上下文摘要',
            },
          },
          order: 70,
          trigger: 'compact',
          takesArgument: true,
        },
        latest: {
          kind: 'command',
          title: {
            fallback: 'Jump to latest',
            translations: { 'zh-CN': '跳到最新消息', 'zh-TW': '跳到最新訊息' },
          },
          description: {
            fallback: 'Return to the newest messages',
            translations: { 'zh-CN': '返回最新消息', 'zh-TW': '返回最新訊息' },
          },
          order: 80,
          shortcut: 'mod+l',
          trigger: 'latest',
        },
        'history-focus': {
          kind: 'command',
          title: {
            fallback: 'Focus conversation',
            translations: { 'zh-CN': '聚焦对话', 'zh-TW': '聚焦對話' },
          },
          description: {
            fallback: 'Scroll the whole conversation',
            translations: { 'zh-CN': '滚动整个对话', 'zh-TW': '捲動整個對話' },
          },
          order: 90,
          shortcut: 'alt+up',
          trigger: 'history',
        },
        'activity-focus': {
          kind: 'command',
          title: {
            fallback: 'Focus activity',
            translations: { 'zh-CN': '聚焦活动面板', 'zh-TW': '聚焦活動面板' },
          },
          description: {
            fallback: 'Read this turn’s independent activity panel',
            translations: { 'zh-CN': '阅读本轮独立的活动面板', 'zh-TW': '閱讀本輪獨立的活動面板' },
          },
          order: 100,
          shortcut: 'alt+down',
          trigger: 'activity',
        },
        stop: {
          kind: 'command',
          title: { fallback: 'Stop', translations: { 'zh-CN': '停止', 'zh-TW': '停止' } },
          description: {
            fallback: 'Cancel the current run',
            translations: { 'zh-CN': '停止当前执行', 'zh-TW': '停止目前執行' },
          },
          order: 110,
          hint: { fallback: 'Esc' },
          trigger: 'stop',
        },
      },
    },
  },
};
