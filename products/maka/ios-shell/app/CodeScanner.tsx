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

import { nativeComponent } from 'nsh';

type ScannerProps = {
  active: boolean;
  torch?: boolean;
  // The preview keeps running. Toggle paused back to false to accept another scan.
  paused?: boolean;
};

type ScannerEvents = {
  scan: { value: string; format: 'qr' };
  error: { code: 'denied' | 'restricted' | 'unavailable' | 'failed'; message: string };
  status: { state: 'initializing' | 'ready' | 'denied' | 'restricted' | 'unavailable' | 'error' };
};

export const CodeScanner = nativeComponent<ScannerProps, ScannerEvents>('MakaCodeScanner', {
  props: ['active', 'torch', 'paused'],
  events: ['scan', 'error', 'status'],
});
