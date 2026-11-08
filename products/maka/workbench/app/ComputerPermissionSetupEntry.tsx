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
import { effect, mount, View, host as shell } from 'nsh';
import { currentWindow } from 'nsh/desktop';
import type { LanguagePreference } from '../../../../packages/plugin-sdk/src/index.js';
import { createHost, HostProvider, uiHost } from './host';
import { initializeAppearance } from './appearance';
import { applyLanguagePreference, tr } from './locale';
import { computerPermissionClient } from './computerPermissionClient';
import { ComputerPermissionSetup } from './ComputerPermissionSetup';
import type { SystemPermissionRequest } from './computerPermissionSetupState';
import { C } from './ui';

function ComputerPermissionSetupEntry() {
  initializeAppearance();
  const host = createHost(uiHost);
  const params = shell.params as {
    systemPermission?: { sessionId: string; requestId: string; request: SystemPermissionRequest };
    nativeApplicationDrag?: boolean;
    languagePreference: { preference: LanguagePreference; revision: number };
  };
  applyLanguagePreference(params.languagePreference.preference, params.languagePreference.revision);
  const owner = params.systemPermission;
  if (!owner?.sessionId || !owner.requestId)
    throw new Error('Missing system permission request identity.');
  const win = currentWindow();
  effect(() => {
    win.set({ title: tr('permissionSetup.title') });
  });
  return (
    <HostProvider value={host}>
      <View class="flex-1 min-h-0" style={{ backgroundColor: C.background }}>
        <ComputerPermissionSetup
          client={computerPermissionClient(host, owner.sessionId, owner.requestId)}
          request={owner.request}
          presentation="window"
          nativeApplicationDrag={params.nativeApplicationDrag === true}
          onClose={async () => {
            await shell.call('computerPermissions.close');
          }}
        />
      </View>
    </HostProvider>
  );
}
mount(ComputerPermissionSetupEntry);
