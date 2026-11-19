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
import { cleanup, effect, signal, Text, View } from 'nsh';
import { tr } from './locale';
import { errorText, renderText } from './text';
import { bodyTextStyle, C } from './ui';
import { useHost } from './host';
import { computerPermissionClient } from './computerPermissionClient';
import { ComputerPermissionSetup } from './ComputerPermissionSetup';
import { PermissionButton } from './ComputerPermissionControls';
import type {
  ComputerPermissionStatus,
  SystemPermissionRequest as PermissionRequest,
} from './computerPermissionSetupState';
export { systemPermissionName } from './ComputerPermissionSetup';

/** Desktop chat is a handoff, not another system-settings troubleshooting surface. */
export function SystemPermissionRequest(props: {
  request: PermissionRequest;
  sessionId: string;
  requestId: string;
  disabled?: boolean;
  onCancel(): void;
  onOutcome(outcome: NonNullable<ComputerPermissionStatus['outcome']>): void;
}) {
  const host = useHost();
  const client = computerPermissionClient(host, props.sessionId, props.requestId);
  const error = signal<unknown | null>(null);
  const opening = signal(false);
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const open = async () => {
    if (!alive || opening() || props.disabled) return;
    opening.set(true);
    error.set(null);
    try {
      await host.openSystemPermissionSetup(props.sessionId, props.requestId);
    } catch (reason) {
      if (alive) error.set(reason);
    } finally {
      if (alive) opening.set(false);
    }
  };
  effect(() => {
    if (!host.systemPermissionWindow) return;
    // One automatic handoff per mounted request; status refresh never reopens a dismissed window.
    void Promise.resolve().then(open);
  });
  return (
    <If
      when={host.systemPermissionWindow}
      else={
        <ComputerPermissionSetup
          client={client}
          request={props.request}
          presentation="inline"
          onOutcome={props.onOutcome}
        />
      }
    >
      <View class="gap-3">
        <Text style={{ ...bodyTextStyle, fontWeight: '600', color: C.text }}>
          {tr('permissionSetup.waiting')}
        </Text>
        <Text style={{ ...bodyTextStyle, color: C.secondary }}>
          {tr('permissionSetup.windowHint')}
        </Text>
        <If when={error()}>
          <Text style={{ ...bodyTextStyle, color: C.danger }}>
            {renderText(errorText(error(), 'Could not update the computer permission request.'))}
          </Text>
        </If>
        <View class="flex-row flex-wrap justify-end gap-2">
          <PermissionButton
            label={tr('permissionSetup.cancel')}
            disabled={props.disabled}
            onPress={props.onCancel}
          />
          <PermissionButton
            label={tr('permissionSetup.reopen')}
            disabled={props.disabled || opening()}
            onPress={() => void open()}
          />
        </View>
      </View>
    </If>
  );
}
