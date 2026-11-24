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
import { one, localizePackage, localizedTitle } from '../../shared/package.js';

const target = {
  type: 'object',
  properties: {
    path: { type: 'array', items: { type: 'string' }, minItems: 1 },
    id: { type: 'string', minLength: 1 },
  },
  required: ['path', 'id'],
  additionalProperties: false,
};

export default localizePackage({
  schemaVersion: 1,
  id: 'maka.conversations',
  displayName: 'Conversations',
  description: 'Browse conversations, read history and coordinate session work.',
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
        hostLogs: one(contracts.hostLogs),
        computer: {
          contract: contracts.workspaceComputer,
          cardinality: { kind: 'optional' },
        },
        terminal: {
          contract: contracts.terminal,
          cardinality: { kind: 'optional' },
        },
        decisions_api: {
          contract: contracts.workspaceDecisionsApi,
          cardinality: { kind: 'optional' },
        },
        web: {
          contract: contracts.workspaceWeb,
          cardinality: { kind: 'optional' },
        },
        skills: {
          contract: contracts.skillLibrary,
          cardinality: { kind: 'optional' },
        },
      },
      contributions: {
        quickConversations: { kind: 'view', contract: 'maka.quick-launcher.tool' },
        rooms: { kind: 'view', contract: 'maka.conversations.rooms' },
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
          title: localizedTitle('Commands'),
        },
        browse: {
          kind: 'command',
          title: localizedTitle('Browse sessions'),
        },
        sessions: {
          kind: 'command',
          title: localizedTitle('Sessions'),
          description: localizedTitle('Resume a conversation'),
          order: 10,
          shortcut: 'mod+o',
          trigger: 'resume',
        },
        find: {
          kind: 'command',
          title: localizedTitle('Find in conversation'),
          description: localizedTitle('Search the messages in this conversation'),
          order: 15,
          trigger: 'find',
        },
        new: {
          kind: 'command',
          title: localizedTitle('New conversation'),
          description: localizedTitle('A fresh start in your workspace'),
          order: 20,
          shortcut: 'mod+n',
          trigger: 'new',
        },
        bot: {
          kind: 'command',
          title: localizedTitle('Open Bot'),
          description: localizedTitle('Your persistent Bot conversation, created on first use'),
          order: 25,
          trigger: 'bot',
        },
        workspace: {
          kind: 'command',
          title: localizedTitle('Choose workspace'),
          description: localizedTitle('Start a conversation in another folder'),
          order: 30,
          trigger: 'workspace',
        },
        models: {
          kind: 'command',
          title: localizedTitle('Models'),
          description: localizedTitle('Choose the model for this conversation'),
          order: 40,
          shortcut: 'mod+g',
          trigger: 'model',
        },
        settings: {
          kind: 'command',
          title: localizedTitle('Connections & models'),
          description: localizedTitle('Add connections, API keys and models'),
          order: 50,
          trigger: 'settings',
        },
        files: {
          kind: 'command',
          title: localizedTitle('Files'),
          description: localizedTitle('Browse workspace files and current changes'),
          order: 60,
          trigger: 'files',
        },
        goal: {
          kind: 'command',
          title: localizedTitle('Goal'),
          description: localizedTitle(
            'Manage a Goal, or start one with /goal followed by an objective',
          ),
          order: 65,
          trigger: 'goal',
          takesArgument: true,
        },
        compact: {
          kind: 'command',
          title: localizedTitle('Compact conversation'),
          description: localizedTitle('Summarize context for the next request'),
          order: 70,
          trigger: 'compact',
          takesArgument: true,
        },
        latest: {
          kind: 'command',
          title: localizedTitle('Jump to latest'),
          description: localizedTitle('Return to the newest messages'),
          order: 80,
          shortcut: 'mod+l',
          trigger: 'latest',
        },
        'history-focus': {
          kind: 'command',
          title: localizedTitle('Focus conversation'),
          description: localizedTitle('Scroll the whole conversation'),
          order: 90,
          shortcut: 'alt+up',
          trigger: 'history',
        },
        'activity-focus': {
          kind: 'command',
          title: localizedTitle('Focus activity'),
          description: localizedTitle('Read this turn’s independent activity panel'),
          order: 100,
          shortcut: 'alt+down',
          trigger: 'activity',
        },
        queue: {
          kind: 'command',
          title: localizedTitle('Add to queue'),
          description: localizedTitle('Send the current draft after this turn'),
          order: 105,
        },
        stop: {
          kind: 'command',
          title: localizedTitle('Stop'),
          description: localizedTitle('Cancel the current run'),
          order: 110,
          hint: { fallback: 'Esc' },
          trigger: 'stop',
        },
      },
    },
  },
});
