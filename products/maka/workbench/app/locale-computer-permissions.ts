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
import type { Catalog } from '../../../../plugins/shared/locale.js';

export const computerPermissionMessages = {
  'permissionSetup.title': ['Set up computer access', '设置电脑访问权限', '設定電腦存取權限'],
  'permissionSetup.subtitle': [
    'Allow {application} to see and interact with the computer. macOS keeps you in control of these permissions.',
    '允许 {application} 查看和操作电脑。这些权限始终由你在 macOS 中控制。',
    '允許 {application} 查看和操作電腦。這些權限始終由你在 macOS 中控制。',
  ],
  'permissionSetup.application': ['Permission application', '获得权限的应用', '取得權限的 App'],
  'permissionSetup.accessibilityPurpose': [
    'Read interface elements, click, and type in applications you allow.',
    '读取界面元素，并在你允许的应用中点击和输入。',
    '讀取介面元素，並在你允許的 App 中點按和輸入。',
  ],
  'permissionSetup.screenPurpose': [
    'See screenshots of the applications and screen you share.',
    '查看你共享的应用和屏幕截图。',
    '查看你分享的 App 和螢幕截圖。',
  ],
  'permissionSetup.ready': ['Ready', '已就绪', '已就緒'],
  'permissionSetup.notEnabled': ['Not enabled yet', '尚未启用', '尚未啟用'],
  'permissionSetup.next': ['Up next', '下一项', '下一項'],
  'permissionSetup.waitingForMac': ['Waiting for macOS', '等待 macOS', '等待 macOS'],
  'permissionSetup.enable': ['Enable {permission}…', '启用{permission}…', '啟用{permission}…'],
  'permissionSetup.openSettings': [
    'Open {permission} settings…',
    '打开{permission}设置…',
    '開啟{permission}設定…',
  ],
  'permissionSetup.progress': [
    '{ready} of {total} ready',
    '{total} 项中已有 {ready} 项就绪',
    '{total} 項中已有 {ready} 項就緒',
  ],
  'permissionSetup.loading': ['Checking permissions…', '正在检查权限…', '正在檢查權限…'],
  'permissionSetup.turnOn': [
    'In System Settings, turn on {application}. This window checks automatically; come back when you’re done.',
    '在系统设置中开启 {application}。此窗口会自动检查，完成后回来即可。',
    '在系統設定中開啟 {application}。此視窗會自動檢查，完成後回來即可。',
  ],
  'permissionSetup.verifying': [
    'Permissions are ready. Waiting for the Host to resume the original call…',
    '权限已就绪，正在等待 Host 继续原调用…',
    '權限已就緒，正在等待 Host 繼續原呼叫…',
  ],
  'permissionSetup.unavailable': [
    'This Host cannot request macOS permissions for this call. Check permissions on the Mac running the Host; status is observed there.',
    '此 Host 无法为本次调用请求 macOS 权限。请在运行 Host 的 Mac 上检查权限；此处会同步那台 Mac 的真实状态。',
    '此 Host 無法為本次呼叫請求 macOS 權限。請在執行 Host 的 Mac 上檢查權限；此處會同步那台 Mac 的實際狀態。',
  ],
  'permissionSetup.complete': ['Computer access is ready', '电脑访问已就绪', '電腦存取已就緒'],
  'permissionSetup.resumed': [
    'The original call can continue. You can close this window.',
    '原调用可以继续了，现在可以关闭此窗口。',
    '原呼叫可以繼續了，現在可以關閉此視窗。',
  ],
  'permissionSetup.closed': ['Setup ended', '设置已结束', '設定已結束'],
  'permissionSetup.closedBody': [
    'This request is no longer waiting for permission. No further changes will be made here.',
    '此请求已不再等待授权。这里不会再发起任何更改。',
    '此請求已不再等待授權。這裡不會再發起任何變更。',
  ],
  'permissionSetup.done': ['Done', '完成', '完成'],
  'permissionSetup.close': ['Close window', '关闭窗口', '關閉視窗'],
  'permissionSetup.cancel': ['Cancel setup', '取消设置', '取消設定'],
  'permissionSetup.cancelling': ['Cancelling setup…', '正在取消设置…', '正在取消設定…'],
  'permissionSetup.closeHint': [
    'Closing this window keeps the call waiting. Cancel setup stops the request.',
    '关闭窗口后，调用仍会等待；取消设置才会终止请求。',
    '關閉視窗後，呼叫仍會等待；取消設定才會終止請求。',
  ],
  'permissionSetup.help': ['Permission still not enabled?', '权限仍未生效？', '權限仍未生效？'],
  'permissionSetup.helpBody': [
    'If the app is missing from the privacy list, choose Show in Finder and drag the selected app into System Settings.',
    '如果隐私列表中没有此应用，请点“在访达中显示”，将选中的应用拖入系统设置。',
    '如果隱私權列表中沒有此 App，請點「在 Finder 中顯示」，將選取的 App 拖入系統設定。',
  ],
  'permissionSetup.restartHint': [
    'If macOS asks to quit and reopen the app, follow its prompt.',
    '如果 macOS 提示退出并重新打开应用，请按提示操作。',
    '若 macOS 提示結束並重新開啟 App，請依提示操作。',
  ],
  'permissionSetup.finder': ['Show in Finder', '在访达中显示', '在 Finder 中顯示'],
  'permissionSetup.drag': [
    'Drag the app into the {permission} list in System Settings, then turn it on.',
    '将应用拖入系统设置的“{permission}”列表，再开启它。',
    '將 App 拖入系統設定的「{permission}」列表，再開啟它。',
  ],
  'permissionSetup.dragFailed': [
    'Couldn’t start dragging. Try dragging the app again.',
    '无法开始拖动，请再拖一次应用图标。',
    '無法開始拖移，請再拖一次 App 圖示。',
  ],
  'permissionSetup.waiting': [
    'Waiting for computer access setup',
    '等待设置电脑访问权限',
    '等待設定電腦存取權限',
  ],
  'permissionSetup.windowHint': [
    'Finish the steps in the computer access window. The original call will continue when permissions are ready.',
    '请在电脑访问窗口中完成设置，权限就绪后原调用会继续。',
    '請在電腦存取視窗中完成設定，權限就緒後原呼叫會繼續。',
  ],
  'permissionSetup.reopen': ['Reopen setup…', '重新打开设置…', '重新開啟設定…'],
} as const satisfies Catalog;
