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

import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

const ZH = {
    shareAction: '分享此任务',
    shareTitle: '分享任务',
    shareDescription: '创建一次性邀请，让另一台 Maka 访问这个任务。',
    enableRemoteAccessTitle: '先开启本机远程访问',
    enableRemoteAccessBody: '已为你打开 Runtime Host 设置；开启远程访问后即可分享此任务。',
    disclosureTitle: '分享前请确认',
    disclosureBody:
      '对方将看到这个任务已有和之后产生的全部可见内容，包括其中已经出现的文件路径、凭据或其他秘密。撤销访问只能阻止后续读取，无法收回对方已经复制的内容。',
    accessLabel: '访问权限',
    observe: '只读',
    observeHelp: '查看完整历史和实时更新',
    requestTurn: '可请求新轮次',
    revokeTurnRequests: '撤销轮次请求权限',
    requestTurnHelp: '查看完整内容，并提交需要你逐次批准的新轮次请求',
    createInvitation: '创建邀请',
    invitationCode: '一次性邀请码',
    invitationHelp: '邀请码包含连接地址和访客凭据，不包含所有者凭据。',
    coordinationReady: '已包含跨网络协调路径',
    coordinationReadyBody:
      'Runtime Host 已取得 Relay reservation；这能提高不同网络中的设备成功建立连接的机会。',
    coordinationUnavailable: '尚未取得 Relay reservation',
    coordinationUnavailableBody:
      '这枚邀请码当前只包含直接路径，不同网络中的设备可能无法连接。可稍后撤销并重新创建。',
    copy: '复制邀请码',
    copied: '邀请码已复制',
    close: '完成',
    activeAccess: '当前访问',
    accessUnavailable: '共享管理暂时不可用；此窗口会自动重试。',
    guest: '访客',
    noAccess: '尚未分享给任何人',
    pending: '待领取',
    active: '已连接',
    revoke: '撤销',
    joinAction: '加入共享任务',
    joinTitle: '加入共享任务',
    joinDescription: '粘贴邀请码，建立独立的访客连接。',
    code: '邀请码',
    pasteInvitation: '粘贴邀请码',
    clipboardEmpty: '剪贴板中没有可粘贴的邀请码。',
    clipboardUnavailable: '剪贴板中没有有效的邀请码；请手动粘贴。',
    join: '加入',
    validatingInvitation: '正在验证邀请码…',
    discoveringHost: '正在查找任务所在的 Runtime Host…',
    preparingRoute: '正在准备可用路径…',
    connectingHost: '正在连接 Runtime Host…',
    authenticatingGuest: '正在验证访客凭据…',
    finalizingAccess: '正在确认访客访问权限…',
    loadingSession: '正在加载共享任务…',
    recoveryStarted: '共享任务正在后台连接',
    recoveryStartedBody: '任务已保存在此设备；连接恢复后会自动出现在任务列表中。',
    invalidCode: '邀请码无效',
    connectionFailed: '无法加入共享任务',
    directPathUnavailable: '未能连接到任务所在的 Runtime Host。请确认当前 Desktop Client 和该 Host 在同一个 Peer Mesh 中，并且存在可用的直连或成员转发路径；可在 Peer Mesh 设置中同步路径并检查成员转发。',
    insecureTitle: '此连接未加密',
    insecureBody: '访客凭据、完整任务内容和轮次请求可能被同一网络中的第三方截获。仅在你了解并接受风险时继续。',
    shareInsecure: '接受风险并创建',
    joinInsecure: '接受风险并加入',
    retainedTasks: '已加入的共享任务',
    disconnect: '断开',
    disconnectFailed: '无法断开共享任务',
    turnRequests: '轮次请求',
    noTurnRequests: '暂无轮次请求',
    approve: '批准',
    reject: '拒绝',
    turnRequestPlaceholder: '描述你希望发起的新轮次',
    submitTurnRequest: '请求新轮次',
    turnRequestSent: '请求已提交，等待所有者批准',
    regenerateRequestSent: '重新生成请求已提交，等待所有者批准',
    turnRequestReconnecting: '正在重连 Runtime Host；草稿会保留，连接恢复后即可发送。',
    turnRequestReconciling: '正在确认请求是否已被 Host 接收…',
    turnRequestPending: '等待批准',
    turnRequestApproved: '已批准',
    turnRequestRejected: '已拒绝',
    turnRequestStarted: '已开始',
    turnRequestBlocked: '未能开始',
    turnRequestFailed: '准入失败',
    dismissTurnRequest: '关闭',
    withdrawTurnRequest: '撤回',
    turnRequestWithdrawn: '请求已撤回',
    turnRequestCount: (count: number) => `${count} 个轮次请求`,
    regenerateRequest: '重新生成回答',
    sharedTask: '共享任务',
    newTurnRequestTitle: (count: number) => count === 1 ? '新的轮次请求' : `${count} 个新的轮次请求`,
    newTurnRequestSummary: (count: number) => `${count} 个轮次请求正在等待审批`,
    reviewTurnRequest: '查看并审批',
    ownerTurnRequestTitle: '访客请求开始新轮次',
    ownerRegenerateRequestTitle: '访客请求重新生成回答',
    viewSourceTurn: '查看原轮次',
    moreTurnRequests: (count: number) => `还有 ${count} 个请求等待审批`,
    pendingTurnRequestCount: (count: number) => `${count} 个待审批轮次请求`,
};

type SessionCollaborationCopy = {
  readonly [Key in keyof typeof ZH]: (typeof ZH)[Key] extends (
    ...args: infer Args
  ) => string
    ? (...args: Args) => string
    : string;
};

const EN = {
    shareAction: 'Share this task',
    shareTitle: 'Share task',
    shareDescription: 'Create a one-time invitation for another Maka installation.',
    enableRemoteAccessTitle: 'Enable remote access first',
    enableRemoteAccessBody:
      'Runtime Host settings are open. Enable remote access there, then share this task.',
    disclosureTitle: 'Confirm what will be shared',
    disclosureBody:
      'The Guest can read all existing and future visible content in this task, including paths, credentials, or other secrets already present. Revoking access stops future reads but cannot retract copied content.',
    accessLabel: 'Access',
    observe: 'Read only',
    observeHelp: 'Read the full history and live updates',
    requestTurn: 'Can request Turns',
    revokeTurnRequests: 'Revoke Turn requests',
    requestTurnHelp: 'Read the task and propose new Turns for your individual approval',
    createInvitation: 'Create invitation',
    invitationCode: 'One-time invitation code',
    invitationHelp: 'The code contains the connection address and Guest credential, never the Owner credential.',
    coordinationReady: 'Cross-network coordination is included',
    coordinationReadyBody:
      'The Runtime Host has obtained a Relay reservation, improving the chance that devices on different networks can connect.',
    coordinationUnavailable: 'No Relay reservation yet',
    coordinationUnavailableBody:
      'This invitation currently contains direct routes only, so devices on different networks may not connect. Revoke and recreate it later.',
    copy: 'Copy invitation',
    copied: 'Invitation copied',
    close: 'Done',
    activeAccess: 'Current access',
    accessUnavailable: 'Sharing controls are temporarily unavailable. This window will retry.',
    guest: 'Guest',
    noAccess: 'No one has access yet',
    pending: 'Pending',
    active: 'Connected',
    revoke: 'Revoke',
    joinAction: 'Join shared task',
    joinTitle: 'Join shared task',
    joinDescription: 'Paste an invitation to create an independent Guest connection.',
    code: 'Invitation code',
    pasteInvitation: 'Paste invitation',
    clipboardEmpty: 'There is no invitation to paste from the clipboard.',
    clipboardUnavailable: 'The clipboard does not contain a valid invitation. Paste it manually.',
    join: 'Join',
    validatingInvitation: 'Validating the invitation…',
    discoveringHost: 'Finding the Runtime Host for this task…',
    preparingRoute: 'Preparing an available route…',
    connectingHost: 'Connecting to the Runtime Host…',
    authenticatingGuest: 'Authenticating the Guest credential…',
    finalizingAccess: 'Confirming Guest access…',
    loadingSession: 'Loading the shared task…',
    recoveryStarted: 'Shared task is connecting in the background',
    recoveryStartedBody: 'The task is saved on this device and will appear in the task list when the connection recovers.',
    invalidCode: 'The invitation code is invalid',
    connectionFailed: 'Could not join the shared task',
    directPathUnavailable: 'Could not reach the Runtime Host for this task. Make sure this Desktop Client and the Host are in the same Peer Mesh and have a usable direct or member-transit path. Sync routes and check member transit in Peer Mesh settings.',
    insecureTitle: 'This connection is not encrypted',
    insecureBody: 'The Guest credential, complete task content, and Turn requests may be intercepted by others on the network. Continue only if you understand and accept the risk.',
    shareInsecure: 'Accept risk and create',
    joinInsecure: 'Accept risk and join',
    retainedTasks: 'Joined shared tasks',
    disconnect: 'Disconnect',
    disconnectFailed: 'Could not disconnect shared task',
    turnRequests: 'Turn requests',
    noTurnRequests: 'No Turn requests yet',
    approve: 'Approve',
    reject: 'Reject',
    turnRequestPlaceholder: 'Describe the new Turn you want to start',
    submitTurnRequest: 'Request new Turn',
    turnRequestSent: 'Request sent for Owner approval',
    regenerateRequestSent: 'Regeneration request sent for Owner approval',
    turnRequestReconnecting: 'Reconnecting to the Runtime Host. Your draft is kept and can be sent when the connection returns.',
    turnRequestReconciling: 'Checking whether the Host received this request…',
    turnRequestPending: 'Awaiting approval',
    turnRequestApproved: 'Approved',
    turnRequestRejected: 'Rejected',
    turnRequestStarted: 'Started',
    turnRequestBlocked: 'Could not start',
    turnRequestFailed: 'Admission failed',
    dismissTurnRequest: 'Dismiss',
    withdrawTurnRequest: 'Withdraw',
    turnRequestWithdrawn: 'Request withdrawn',
    turnRequestCount: (count: number) => `${count} Turn ${count === 1 ? 'request' : 'requests'}`,
    regenerateRequest: 'Regenerate response',
    sharedTask: 'Shared task',
    newTurnRequestTitle: (count: number) => count === 1 ? 'New Turn request' : `${count} new Turn requests`,
    newTurnRequestSummary: (count: number) => `${count} Turn requests are waiting for approval`,
    reviewTurnRequest: 'Review',
    ownerTurnRequestTitle: 'A Guest requested a new Turn',
    ownerRegenerateRequestTitle: 'A Guest requested a regenerated response',
    viewSourceTurn: 'View original Turn',
    moreTurnRequests: (count: number) => `${count} more ${count === 1 ? 'request' : 'requests'} waiting`,
    pendingTurnRequestCount: (count: number) => `${count} pending Turn ${count === 1 ? 'request' : 'requests'}`,
} satisfies SessionCollaborationCopy;

const COPY = { zh: ZH, en: EN } satisfies UiCatalog<SessionCollaborationCopy>;

export function getSessionCollaborationCopy(locale: UiLocale) {
  return COPY[locale];
}
