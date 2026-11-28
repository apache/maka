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
import { mount, View, Text, signal, host as shell } from 'nsh';
import { Window } from 'nsh/desktop';
import type { LanguagePreference } from '../../../../packages/plugin-sdk/src/index.js';
import { TITLE_BAR_HEIGHT } from './chrome';
import { createHost, HostProvider, uiHost } from './host';
import { initializeAppearance } from './appearance';
import { applyLanguagePreference, tr } from './locale';
import { installWorkbenchLocaleCatalog } from './localeCatalog';
import { computerPermissionClient } from './computerPermissionClient';
import { SettingsButton } from './SettingsPage';
import {
  ComputerPermissionSetup,
  PermissionApplication,
  systemPermissionName,
} from './ComputerPermissionSetup';
import type { SystemPermissionRequest } from './computerPermissionSetupState';
import { C, captionTextStyle } from './ui';

function ComputerPermissionSetupEntry() {
  const params = shell.params as {
    settingsGuide?: { application: string; grant: Parameters<typeof systemPermissionName>[0] };
    systemPermission?: { sessionId: string; requestId: string; request: SystemPermissionRequest };
    nativeApplicationDrag?: boolean;
    languagePreference: {
      preference: LanguagePreference;
      revision: number;
      resolvedLanguage?: string;
    };
  };
  applyLanguagePreference(
    params.languagePreference.preference,
    params.languagePreference.revision,
    params.languagePreference.resolvedLanguage,
  );
  installWorkbenchLocaleCatalog();
  void initializeAppearance();
  if (params.settingsGuide) {
    const { application, grant } = params.settingsGuide;
    const error = signal('');
    const reveal = async () => {
      try {
        await shell.call('permissionGuide.reveal');
      } catch {
        error.set(tr('permissionGuide.finderFailed'));
      }
    };
    return (
      <Window
        id="main"
        title={systemPermissionName(grant)}
        titleBar={{ style: 'hidden', height: 0 }}
      >
        <View class="flex-1 p-3 gap-1" style={{ backgroundColor: C.surface }}>
          <Text style={{ fontSize: 15, fontWeight: '600', color: C.text }}>
            {systemPermissionName(grant) + ' · ' + application}
          </Text>
          <View class="flex-row items-center gap-3">
            <If when={params.nativeApplicationDrag}>
              <PermissionApplication
                class="w-12 h-12"
                accessibilityLabel={application}
                onDragError={() => error.set(tr('permissionSetup.dragFailed'))}
              />
            </If>
            <View class="flex-1 gap-1">
              <Text style={{ ...captionTextStyle, color: C.text }}>
                {tr('permissionGuide.switch', { application })}
              </Text>
              <If when={params.nativeApplicationDrag}>
                <Text style={{ ...captionTextStyle, color: C.secondary }}>
                  {tr('permissionGuide.drag')}
                </Text>
              </If>
            </View>
          </View>
          <If when={error()}>
            <Text style={{ ...captionTextStyle, color: C.danger }}>{error()}</Text>
          </If>
          <View class="flex-row justify-end gap-2">
            <If when={params.nativeApplicationDrag}>
              <SettingsButton
                tone="quiet"
                label={tr('permissionSetup.finder')}
                onPress={() => void reveal()}
              />
            </If>
            <SettingsButton
              label={tr('Close')}
              onPress={() => void shell.call('computerPermissions.close')}
            />
          </View>
        </View>
      </Window>
    );
  }
  const host = createHost(uiHost);
  const owner = params.systemPermission;
  if (!owner?.sessionId || !owner.requestId)
    throw new Error('Missing system permission request identity.');
  return (
    <Window
      id="main"
      title={tr('permissionSetup.title')}
      titleBar={{ style: 'hidden', height: TITLE_BAR_HEIGHT }}
    >
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
    </Window>
  );
}
mount(ComputerPermissionSetupEntry);
