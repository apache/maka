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
import { mount, nativeComponent, signal, Text, View, host as shell } from 'nsh';
import { ComputerPermissionSetup } from '../../app/ComputerPermissionSetup';
import { PermissionButton } from '../../app/ComputerPermissionControls';
import { currentLocale } from '../../app/locale';
import { C, bodyTextStyle, captionTextStyle } from '../../app/ui';
import type {
  ComputerPermissionClient,
  ComputerPermissionStatus,
} from '../../app/computerPermissionSetupState';
import type { SystemPermissionGrant } from '../../../../../packages/plugin-sdk/src/generated/runtime';

const PermissionApplication = nativeComponent('maka.permissionApplication', {
  props: [],
});

mount(() => {
  const params = shell.params as
    | {
        previewNativeWindow?: boolean;
        nativeApplicationDrag?: boolean;
        previewApplicationName?: string;
        permissionRequestDenied?: boolean;
      }
    | undefined;
  if (params?.nativeApplicationDrag === true && params.previewApplicationName) {
    const copy = () =>
      currentLocale() === 'zh-CN'
        ? {
            title: '拖入测试应用',
            instruction:
              '将图标拖入系统设置的“录屏与系统录音”列表，再打开该测试应用的开关。不要操作正式 Maka Host。',
            close: '关闭窗口',
          }
        : currentLocale() === 'zh-TW'
          ? {
              title: '拖入測試應用程式',
              instruction:
                '將圖示拖入系統設定的「螢幕與系統音訊錄製」列表，再開啟此測試應用程式的開關。不要操作正式 Maka Host。',
              close: '關閉視窗',
            }
          : {
              title: 'Drag the test application',
              instruction:
                'Drag this icon into Screen & System Audio Recording in System Settings, then turn on this test application. Do not change the production Maka Host.',
              close: 'Close window',
            };
    return (
      <View
        class="flex-1 min-h-0"
        desktop={{ windowDrag: false }}
        style={{ backgroundColor: C.background }}
      >
        <View
          class="h-12 shrink-0 justify-center px-6"
          desktop={{ windowDrag: true }}
          style={{
            backgroundColor: C.surface,
            borderBottomWidth: 1,
            borderBottomColor: C.line,
          }}
        >
          <Text style={{ ...bodyTextStyle, fontWeight: '600', color: C.text }}>{copy().title}</Text>
        </View>
        <View
          class="flex-1 min-h-0 items-center justify-center gap-6 p-6"
          desktop={{ windowDrag: false }}
        >
          <Text style={{ ...bodyTextStyle, fontWeight: '600', color: C.text }}>
            {params.previewApplicationName}
          </Text>
          <PermissionApplication
            class="h-32 w-32"
            desktop={{ windowDrag: false }}
            accessibilityLabel={copy().title}
          />
          <Text style={{ ...bodyTextStyle, color: C.secondary }}>{copy().instruction}</Text>
        </View>
        <View class="items-end p-4" style={{ borderTopWidth: 1, borderTopColor: C.line }}>
          <PermissionButton
            label={copy().close}
            onPress={async () => {
              await shell.call('computerPermissions.close');
            }}
          />
        </View>
      </View>
    );
  }

  const previewCopy = () =>
    currentLocale() === 'zh-CN'
      ? {
          title: '仅预览：不会申请系统权限',
          approve: '模拟系统批准',
          remote: '查看远程主机',
          requests: '请求',
          cancellations: '取消',
          closed: '已关闭',
          yes: '是',
          no: '否',
          application: 'Maka 主机',
        }
      : currentLocale() === 'zh-TW'
        ? {
            title: '僅預覽：不會申請系統權限',
            approve: '模擬系統核准',
            remote: '查看遠端主機',
            requests: '請求',
            cancellations: '取消',
            closed: '已關閉',
            yes: '是',
            no: '否',
            application: 'Maka 主機',
          }
        : {
            title: 'Preview only: no system permission requests',
            approve: 'Approve OS prompt',
            remote: 'Observe remote Host',
            requests: 'requests',
            cancellations: 'cancellations',
            closed: 'closed',
            yes: 'true',
            no: 'false',
            application: 'Maka Host',
          };

  const closed = signal(false);
  const calls = signal(0);
  const cancellations = signal(0);
  const pending = signal<SystemPermissionGrant | null>(null);
  const remote = signal(false);
  let release: ((status: ComputerPermissionStatus) => void) | null = null;
  const ready = new Set<SystemPermissionGrant>();
  let settled = false;
  let cancelled = false;
  const status = (): ComputerPermissionStatus => ({
    record: {
      sessionId: 'session',
      requestId: 'request',
      turnId: 'turn',
      runId: 'run',
      createdAt: 1,
      request: {
        kind: 'system_permission',
        toolUseId: 'tool',
        application: params?.previewApplicationName ?? previewCopy().application,
        grants: ['accessibility', 'screen_recording'],
        applicationLocation: null,
      },
      outcome: cancelled
        ? { kind: 'closure', reason: 'producer_cancelled', committedAt: 2 }
        : settled
          ? { kind: 'system_permission_granted', committedAt: 2 }
          : null,
    },
    requestable: !remote(),
    grants: (['accessibility', 'screen_recording'] as const).map((grant) => ({
      grant,
      effective: ready.has(grant),
    })),
  });
  const client: ComputerPermissionClient = {
    status: async () => status(),
    actions: async () =>
      remote() ? [] : ['accessibility', 'screen_recording', 'reveal_application'],
    request: async (grant) => {
      calls.update((count) => count + 1);
      if (params?.permissionRequestDenied) return status();
      pending.set(grant);
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    action: async () => {},
    cancel: async () => {
      cancellations.update((count) => count + 1);
      cancelled = true;
    },
  };
  const approve = () => {
    const grant = pending();
    if (!grant) return;
    ready.add(grant);
    settled = ready.size === 2;
    pending.set(null);
    release?.(status());
    release = null;
  };
  return (
    <View class="flex-1 min-h-0">
      <View class="gap-2 p-2" style={{ backgroundColor: C.surface }}>
        <Text style={{ ...captionTextStyle, color: C.secondary }}>{previewCopy().title}</Text>
        <View class="flex-row flex-wrap gap-2">
          <PermissionButton label={previewCopy().approve} disabled={!pending()} onPress={approve} />
          <PermissionButton label={previewCopy().remote} onPress={() => remote.set(true)} />
        </View>
        <Text style={{ ...captionTextStyle, color: C.secondary }}>
          {previewCopy().requests}={calls()} {previewCopy().cancellations}={cancellations()}{' '}
          {previewCopy().closed}={closed() ? previewCopy().yes : previewCopy().no}
        </Text>
      </View>
      <If when={!closed()}>
        <ComputerPermissionSetup
          client={client}
          presentation="window"
          nativeApplicationDrag={params?.nativeApplicationDrag === true}
          onClose={async () => {
            if (params?.previewNativeWindow === true) await shell.call('computerPermissions.close');
            else closed.set(true);
          }}
        />
      </If>
    </View>
  );
});
