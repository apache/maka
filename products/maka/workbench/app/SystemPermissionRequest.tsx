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
import { Text, View } from 'nsh';
import type {
  InteractionRequest,
  SystemPermissionGrant,
} from '../../../../packages/plugin-sdk/src/generated/runtime';
import { tr } from './locale';
import { bodyTextStyle, C, captionTextStyle } from './ui';

export type SystemPermissionRequest = Extract<InteractionRequest, { kind: 'system_permission' }>;

/** The System Settings pane that holds each grant. */
const panes: Record<SystemPermissionGrant, string> = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screen_recording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
};

export function systemPermissionPane(grant: SystemPermissionGrant): string {
  return panes[grant];
}

/** The grant's name as System Settings shows it. */
export function systemPermissionName(grant: SystemPermissionGrant): string {
  return grant === 'accessibility' ? tr('Accessibility') : tr('Screen & System Audio Recording');
}

export function SystemPermissionRequest(props: { request: SystemPermissionRequest }) {
  return (
    <View style={{ gap: 16 }}>
      <Text style={[{ ...bodyTextStyle, color: C.text }, { userSelect: 'text' }]}>
        {tr(
          '{application} needs these macOS permissions to use the computer. Turn them on in System Settings; the request continues on its own once they are on.',
          { application: props.request.application },
        )}
      </Text>
      <View style={{ gap: 8 }}>
        <Each of={props.request.grants}>
          {(grant) => (
            <Text
              style={[
                { ...bodyTextStyle, color: C.text, fontWeight: '600' },
                { userSelect: 'text' },
              ]}
            >
              {systemPermissionName(grant())}
            </Text>
          )}
        </Each>
      </View>
      <Text style={{ ...captionTextStyle, color: C.muted }}>
        {tr(
          'If {application} is not listed, reopen System Settings, or add it with the + button.',
          {
            application: props.request.application,
          },
        )}
      </Text>
    </View>
  );
}
