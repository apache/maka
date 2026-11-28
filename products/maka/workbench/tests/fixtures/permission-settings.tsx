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

import { cleanup, mount } from 'nsh';
import { installWorkbenchLocaleCatalog } from '../../app/localeCatalog';
import { createPermissionSettings } from '../../app/permissionSettingsState';
import { SystemPermissionSettings } from '../../app/SystemPermissionSettings';

mount(() => {
  installWorkbenchLocaleCatalog();
  let microphone: 'notDetermined' | 'denied' = 'notDetermined';
  const owner = createPermissionSettings({
    observePermissionSetting: async () => ({ effective: false, pendingHost: false }),
    desktopPermissionSettings: async () => ({
      supported: true,
      application: 'Maka Dev',
      canReveal: true,
      canRestart: true,
      microphone,
      screen_recording: false,
      accessibility: true,
    }),
    hostPermissionSettings: async () => ({
      local: false,
      status: {
        supported: true,
        application: 'Remote Host',
        bundlePath: '/Remote.app',
        stateDomain: 'remote',
        grants: [
          { grant: 'accessibility', effective: false },
          { grant: 'screen_recording', effective: false, pendingHost: true },
        ],
      },
    }),
    performPermissionSetting: async (_subject, action, grant) => {
      if (action === 'request' && grant === 'microphone') {
        microphone = 'denied';
        return;
      }
      if (action === 'open' && grant === 'screen_recording') return;
      throw Error('fixture: unavailable');
    },
  });
  owner.activate();
  cleanup(owner.deactivate);
  return <SystemPermissionSettings owner={owner} />;
});
