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

import type { ClientCapabilityOffer } from '../../protocol/index.js';

export const WORKHUB_BROWSER_TOOL_NAMES = [
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_wait',
  'browser_extract',
] as const;

/** The Desktop capability shape required by the WorkHub v2 tool profile. */
export function workHubDesktopCapabilityOffers(
  workHubToolNames: readonly string[] = ['control', 'tasks'],
): readonly ClientCapabilityOffer[] {
  return [
    {
      offerId: 'desktop-workhub',
      version: '0',
      affinity: 'session',
      hostPathAccess: 'none',
      label: 'Desktop WorkHub',
      tools: workHubToolNames.map((name) => ({
        serverId: 'desktop_workhub',
        name,
        inputSchema: { type: 'object', additionalProperties: false },
      })),
    },
    {
      offerId: 'desktop-browser',
      version: '0',
      affinity: 'session',
      hostPathAccess: 'none',
      label: 'Browser',
      tools: WORKHUB_BROWSER_TOOL_NAMES.map((name) => ({
        serverId: 'desktop_browser',
        name,
        inputSchema: { type: 'object', additionalProperties: false },
      })),
    },
  ];
}
