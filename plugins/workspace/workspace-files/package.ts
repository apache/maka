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
import { native, one } from '../../shared/package.js';
export default {
  schemaVersion: 1,
  id: 'maka.agent.workspace-files',
  displayName: 'Workspace files',
  description: 'Read and modify files within granted workspace access.',
  localizations: {
    'zh-CN': { displayName: '工作区文件', description: '在获准的工作区范围内读取和修改文件。' },
  },
  application: {
    host: native(sdk.nativeImplementations.workspaceFiles),
    ui: {
      module: 'ui/index.js',
      configuration: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      imports: {
        agent: one(sdk.contracts.agent),
        terminal: { contract: sdk.contracts.terminal, cardinality: { kind: 'optional' } },
      },
      contributions: {
        workspace: { kind: 'view', contract: 'maka.workspace.preview' },
        changes: {
          kind: 'panel',
          title: {
            fallback: 'Changes',
            translations: { 'zh-CN': '更改', 'zh-TW': '變更' },
          },
        },
        'change-diff': {
          kind: 'panel',
          title: {
            fallback: 'Current diff',
            translations: { 'zh-CN': '当前差异', 'zh-TW': '目前差異' },
          },
        },
        'show-changes': {
          kind: 'command',
          title: {
            fallback: 'Changes',
            translations: { 'zh-CN': '更改', 'zh-TW': '變更' },
          },
        },
        glob: { kind: 'tool_renderer', presentation: 'maka.workspace.Files@1/glob' },
        grep: { kind: 'tool_renderer', presentation: 'maka.workspace.Files@1/grep' },
      },
    },
  },
};
