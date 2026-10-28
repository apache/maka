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
  id: 'maka.workbench',
  displayName: 'Maka',
  description: 'Compose the Maka workbench layout from UI contributions.',
  localizations: {
    'zh-CN': { displayName: 'Maka', description: '通过 UI 贡献组合 Maka 工作台布局。' },
  },
  application: {
    ui: {
      module: 'app/App.js',
      configuration: {
        type: 'object',
        properties: { navigation: target, session: target, preview: target, settings: target },
        required: ['navigation', 'session', 'preview', 'settings'],
        additionalProperties: false,
      },
      imports: {},
      contributions: { root: { kind: 'root' } },
    },
  },
};
