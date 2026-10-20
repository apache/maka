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

import type { MakaBridge } from '../../../preload/bridge-contract.js';
import type { AssistantSessionVisibilitySource } from '../../application/contracts/session-catalog/assistant-session-visibility.js';

export function createDesktopAssistantSessionVisibilitySource(
  bridge: { settings: Pick<MakaBridge['settings'], 'getClient' | 'updateClient' | 'subscribeClientChanged'> } = window.maka,
): AssistantSessionVisibilitySource {
  return {
    read: async () => (await bridge.settings.getClient()).appearance.showAssistantBackgroundSessions === true,
    write: async (value) => { await bridge.settings.updateClient({ appearance: { showAssistantBackgroundSessions: value } }); },
    subscribeChanges: (listener) => bridge.settings.subscribeClientChanged(listener),
  };
}
