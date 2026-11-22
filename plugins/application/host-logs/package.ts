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
import { native } from '../../shared/package.js';
export default {
  schemaVersion: 1,
  id: 'maka.application.host-logs',
  displayName: 'Host logs',
  description: 'Read and follow captured logs from the connected Host.',
  localizations: {
    'zh-CN': { displayName: 'Host 日志', description: '查看和跟随所连接 Host 的已捕获日志。' },
    'zh-TW': { displayName: 'Host 日誌', description: '查看和跟隨所連線 Host 的已擷取日誌。' },
  },
  application: { host: native(sdk.nativeImplementations.hostLogs) },
};
