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

export default {
  schemaVersion: 1,
  id: 'maka.composer',
  displayName: 'Composer',
  description: 'Compose messages with skills, files, images and session controls.',
  localizations: {
    'zh-CN': { displayName: '消息输入', description: '通过技能、文件、图片和会话控件编写消息。' },
  },
  application: {
    ui: {
      module: 'ui/index.js',
      configuration: { type: 'object', properties: {}, additionalProperties: false },
      imports: {},
      contributions: { composer: { kind: 'view', contract: 'maka.composer' } },
    },
  },
};
