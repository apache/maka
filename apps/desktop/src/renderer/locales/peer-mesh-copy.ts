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

import type { PeerMeshMemberProjection, PeerMeshQueryResult } from '@maka/runtime-host/protocol';
import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

export interface PeerMeshCopy {
  readonly title: string;
  readonly experimental: string;
  readonly failed: string;
  readonly invalidResult: string;
  readonly unknownError: string;
  readonly outcomeUnknown: string;
  readonly invitationOutcomeUnknown: string;
  readonly outcomeUnknownRefreshFailed: string;
  readonly unavailable: string;
  readonly loading: string;
  readonly checkingPeerConnection: string;
  readonly peerConnectionDisabled: string;
  readonly peerConnectionDisabledHint: string;
  readonly peerConnectionDisableProfileFirst: string;
  readonly enablePeerConnection: string;
  readonly peerConnectionStarting: string;
  readonly peerConnectionStartingHint: string;
  readonly peerConnectionUpgradeRequired: string;
  readonly peerConnectionUpgradeRequiredHint: string;
  readonly working: Record<
    'refresh' | 'create' | 'join' | 'invite' | 'add-host' | 'enable-peer' | 'update' | 'rename',
    string
  >;
  readonly settling: string;
  readonly endpoint: string;
  readonly desktopEndpoint: string;
  readonly hostEndpoint: string;
  readonly desktopEndpointHelp: string;
  readonly hostEndpointHelp: string;
  readonly advancedSettings: string;
  readonly technicalDetails: string;
  readonly connectivityAutomatic: string;
  readonly connectivityKnownRoutesOnly: string;
  readonly connectivityCustom: string;
  readonly restartRequired: string;
  readonly adaptiveConnectivity: string;
  readonly adaptiveConnectivityHelp: string;
  readonly connectivityPolicyLoading: string;
  readonly connectivityPolicyLoadFailed: string;
  readonly connectivityPolicySaveFailed: string;
  readonly restoreDefaultConnectivityPolicy: string;
  readonly connectivityPolicyRestartRequired: string;
  readonly publicAddressDiscovery: string;
  readonly publicStunDefault: string;
  readonly publicStunDisabled: string;
  readonly publicStunCustom: string;
  readonly customStunUrls: string;
  readonly customStunUrlsInvalid: string;
  readonly publicStunDefaultHelp: string;
  readonly publicStunDisabledHelp: string;
  readonly publicStunCustomHelp: string;
  readonly saveConnectivityPolicy: string;
  readonly peerId: string;
  readonly peerIdHelp: string;
  readonly meshId: string;
  readonly meshIdHelp: string;
  readonly thisRuntimeHost: string;
  readonly thisDesktop: string;
  readonly displayName: string;
  readonly meshDisplayName: string;
  readonly unnamedMesh: string;
  readonly rename: string;
  readonly renameMesh: string;
  readonly save: string;
  readonly peerIdCopied: string;
  readonly meshIdCopied: string;
  copyPeerId(value: string): string;
  copyMeshId(value: string): string;
  readonly empty: string;
  readonly emptyHint: string;
  readonly meshes: string;
  readonly mesh: string;
  readonly members: string;
  activeMeshCount(value: number): string;
  showClosedMeshes(value: number): string;
  readonly noActiveMeshes: string;
  readonly noActiveMeshesHint: string;
  readonly authority: string;
  readonly member: string;
  readonly closed: string;
  memberCount(value: number): string;
  pending(value: number): string;
  readonly transit: string;
  readonly transitHelp: string;
  readonly transitToggle: string;
  readonly transitStatus: string;
  readonly transitLimitsLabel: string;
  transitLimits(value: PeerMeshQueryResult['transit']): string;
  readonly allowedMembers: string;
  readonly reservations: string;
  readonly circuits: string;
  readonly routeState: Record<PeerMeshMemberProjection['state'], string>;
  readonly endpointKind: Record<'client' | 'host' | 'unknown', string>;
  readonly endpointKindHelp: Record<'client' | 'host' | 'unknown', string>;
  readonly joinTitle: string;
  readonly joinHint: string;
  readonly joinCode: string;
  readonly join: string;
  readonly joinMesh: string;
  readonly invite: string;
  readonly invitationTitle: string;
  invitationFor(value: string): string;
  readonly invitationWarning: string;
  readonly invitationDirectOnly: string;
  invitationExpires(value: string): string;
  readonly invitationCopied: string;
  readonly copyInvitation: string;
  readonly create: string;
  readonly refresh: string;
  readonly back: string;
  readonly leave: string;
  readonly closeMesh: string;
  readonly remove: string;
  readonly cancel: string;
  readonly closeConfirm: string;
  readonly leaveConfirm: string;
  readonly removeConfirm: string;
  readonly meshActions: string;
  memberActions(peerId: string): string;
  readonly addLocalHost: string;
  readonly localRuntimeHost: string;
  readonly localHostMissing: string;
  readonly localHostMissingHint: string;
}

const PEER_MESH_COPY = {
  'zh-CN': {
    title: 'Peer Mesh',
    experimental: '实验性',
    failed: 'Peer Mesh 操作失败',
    invalidResult: 'Peer Mesh 返回了无效结果',
    unknownError: 'Peer Mesh 操作失败',
    outcomeUnknown: 'Host 可能已完成此操作。已刷新当前状态，请确认后再重试。',
    invitationOutcomeUnknown:
      'Host 可能已创建邀请码，但代码未能返回且无法恢复。它会自动过期；创建新邀请前请先检查待使用邀请数量。',
    outcomeUnknownRefreshFailed:
      'Host 可能已完成此操作，但当前状态也未能刷新。请恢复连接并刷新后再重试。',
    unavailable: '当前 endpoint 不支持 Peer Mesh',
    loading: '正在读取 Mesh 状态…',
    checkingPeerConnection: '正在检查此 Runtime Host 的 Peer 连接…',
    peerConnectionDisabled: '此 Runtime Host 尚未开启 Peer 连接',
    peerConnectionDisabledHint:
      '开启后，此 Host 才能创建或加入 Mesh；现有 SSH 连接会继续保留。',
    peerConnectionDisableProfileFirst:
      '此 Host 的 Direct peer 连接正在使用中，请先在 Host 列表中将它停用。',
    enablePeerConnection: '开启 Peer 连接',
    peerConnectionStarting: 'Peer 连接已开启，Mesh endpoint 正在就绪',
    peerConnectionStartingHint: '通常只需几秒；也可以立即重新检查。',
    peerConnectionUpgradeRequired: '此 Runtime Host 版本尚不支持 Peer Mesh 管理',
    peerConnectionUpgradeRequiredHint: '请先更新此 Host，再回来开启 Peer 连接。',
    working: {
      refresh: '正在刷新 Peer Mesh…',
      create: '正在创建 Mesh…',
      join: '正在加入 Mesh…',
      invite: '正在准备邀请…',
      'add-host': '正在将 Runtime Host 加入 Mesh…',
      'enable-peer': '正在为 Runtime Host 开启 Peer 连接…',
      update: '正在更新 Mesh…',
      rename: '正在保存名称…',
    },
    settling: '正在确认最终状态…',
    endpoint: '管理对象',
    desktopEndpoint: 'Desktop Client',
    hostEndpoint: '本机 Runtime Host',
    desktopEndpointHelp: '此 Client 用于连接 Mesh 中的 Runtime Host。',
    hostEndpointHelp: '此 Host 加入后，其他成员才能连接本机分享的任务。',
    advancedSettings: '高级设置',
    technicalDetails: '身份与连接配置',
    connectivityAutomatic: '自动连接（推荐）',
    connectivityKnownRoutesOnly: '仅使用已知路径',
    connectivityCustom: '自定义地址发现',
    restartRequired: '需要重启',
    adaptiveConnectivity: '自适应连接',
    adaptiveConnectivityHelp:
      'Maka 会自动竞速可用的直连方式，并在获准时使用成员转发；这里不需要选择具体协议。',
    connectivityPolicyLoading: '正在读取连接策略…',
    connectivityPolicyLoadFailed: '无法读取连接策略',
    connectivityPolicySaveFailed: '无法保存连接策略',
    restoreDefaultConnectivityPolicy: '恢复默认设置',
    connectivityPolicyRestartRequired:
      '重启 Maka 后，已保存的连接策略变更会应用到新连接。',
    publicAddressDiscovery: '公网地址发现',
    publicStunDefault: '公共 STUN（推荐）',
    publicStunDisabled: '不使用公共 STUN',
    publicStunCustom: '自定义 STUN',
    customStunUrls: 'STUN 地址',
    customStunUrlsInvalid:
      '请输入以逗号分隔的 stun:主机[:端口] 地址，最多 8 个。',
    publicStunDefaultHelp:
      '使用 Cloudflare 公共 STUN 尽力发现公网映射。它不承载 Maka 流量，但提供方可观察源 IP 和请求时间；Maka 不保证其可用性。',
    publicStunDisabledHelp:
      '仅尝试本地地址和其他已知直连路径；跨 NAT 的直连成功率可能降低。',
    publicStunCustomHelp:
      '使用逗号分隔的 stun: 地址。STUN 只发现网络地址，不承载 Session 内容。',
    saveConnectivityPolicy: '保存更改',
    peerId: 'Peer ID',
    peerIdHelp: '此 endpoint 在 Mesh 中的技术身份；点击 ID 可复制完整值。',
    meshId: 'Mesh ID',
    meshIdHelp: '用于诊断和识别此 Mesh；点击 ID 可复制完整值。',
    thisRuntimeHost: '本机 Runtime Host',
    thisDesktop: '本机 Desktop',
    displayName: '在 Mesh 中显示的名称',
    meshDisplayName: 'Mesh 名称',
    unnamedMesh: '未命名 Mesh',
    rename: '修改名称',
    renameMesh: '修改 Mesh 名称',
    save: '保存',
    peerIdCopied: 'Peer ID 已复制',
    meshIdCopied: 'Mesh ID 已复制',
    copyPeerId: (value: string) => `复制完整 Peer ID：${value}`,
    copyMeshId: (value: string) => `复制完整 Mesh ID：${value}`,
    empty: '建立你的第一个 Mesh',
    emptyHint: '创建新 Mesh，或通过一次性邀请码加入。',
    meshes: 'Mesh',
    mesh: 'Mesh',
    members: '成员',
    activeMeshCount: (value: number) => `${value} 个使用中`,
    showClosedMeshes: (value: number) => `显示已关闭（${value}）`,
    noActiveMeshes: '没有使用中的 Mesh',
    noActiveMeshesHint: '已关闭的 Mesh 默认隐藏；可通过上方筛选查看。',
    authority: '管理者',
    member: '成员',
    closed: '已关闭',
    memberCount: (value: number) => `${value} 个成员`,
    pending: (value: number) => `${value} 个待使用邀请`,
    transit: '成员转发',
    transitHelp: '允许此 Mesh 的成员通过本机建立连接；会使用本机带宽。',
    transitToggle: '为此 Mesh 提供转发',
    transitStatus: '成员转发状态',
    transitLimitsLabel: '成员转发限制',
    transitLimits: (value: PeerMeshQueryResult['transit']) =>
      value
        ? `固定上限：每个成员 ${value.maxCircuitsPerPeer} 条连接，每条最长 ${formatHours(value.maxCircuitDurationSeconds)}，最多 ${formatMebibytes(value.maxCircuitBytes)}。一次只能为一个 Mesh 开启。`
        : '成员转发使用固定资源上限，一次只能为一个 Mesh 开启。',
    allowedMembers: '允许成员',
    reservations: 'Reservation',
    circuits: '连接',
    routeState: {
      local: '本机',
      connecting: '正在连接',
      reachable: '可达',
      reconnecting: '正在恢复连接',
      needs_repair: '需要新邀请码修复',
    },
    endpointKind: {
      client: 'Client',
      host: 'Runtime Host',
      unknown: '未标识 Peer',
    },
    endpointKindHelp: {
      client: 'Client 是操作界面：它连接 Host、浏览任务并发起操作，本身不持有任务。',
      host: 'Runtime Host 持有任务和运行状态，并执行经过授权的工作。',
      unknown: '此 Peer 尚未报告它是 Client 还是 Runtime Host，通常来自旧版本。',
    },
    joinTitle: '加入 Mesh',
    joinHint: '粘贴另一个 Peer 生成的一次性邀请码。',
    joinCode: '邀请码',
    join: '加入',
    joinMesh: '加入 Mesh',
    invite: '邀请成员',
    invitationTitle: '邀请成员',
    invitationFor: (value: string) => `Mesh ${value}`,
    invitationWarning: '该代码只能使用一次；获得代码的人可以让一个 peer 加入此 Mesh。',
    invitationDirectOnly:
      '尚未连接到协调节点。此邀请码只包含直接地址，跨 NAT 时可能无法连接。',
    invitationExpires: (value: string) => `有效期至 ${value}`,
    invitationCopied: '邀请码已复制',
    copyInvitation: '复制邀请码',
    create: '创建 Mesh',
    refresh: '刷新',
    back: '返回',
    leave: '退出 Mesh',
    closeMesh: '关闭 Mesh',
    remove: '移除成员',
    cancel: '取消',
    closeConfirm: '关闭这个 Mesh？',
    leaveConfirm: '退出这个 Mesh？',
    removeConfirm: '移除这个成员？',
    meshActions: 'Mesh 操作',
    memberActions: (peerId: string) => `${peerId} 的操作`,
    addLocalHost: '添加本机 Runtime Host',
    localRuntimeHost: 'Runtime Host',
    localHostMissing: '本机 Runtime Host 尚未加入',
    localHostMissingHint: '加入后，其他成员才能通过此 Mesh 连接本机分享的任务。',
  },
  'zh-TW': {
    title: 'Peer Mesh',
    experimental: '實驗性',
    failed: 'Peer Mesh 操作失敗',
    invalidResult: 'Peer Mesh 回傳了無效結果',
    unknownError: 'Peer Mesh 操作失敗',
    outcomeUnknown: 'Host 可能已完成此操作。已重新整理目前狀態，請確認後再重試。',
    invitationOutcomeUnknown:
      'Host 可能已建立邀請碼，但代碼未能回傳且無法復原。它會自動過期；建立新邀請前請先檢查待使用邀請數量。',
    outcomeUnknownRefreshFailed:
      'Host 可能已完成此操作，但目前狀態也無法重新整理。請恢復連線並重新整理後再重試。',
    unavailable: '目前 endpoint 不支援 Peer Mesh',
    loading: '正在讀取 Mesh 狀態…',
    checkingPeerConnection: '正在檢查此 Runtime Host 的 Peer 連線…',
    peerConnectionDisabled: '此 Runtime Host 尚未開啟 Peer 連線',
    peerConnectionDisabledHint:
      '開啟後，此 Host 才能建立或加入 Mesh；現有 SSH 連線會繼續保留。',
    peerConnectionDisableProfileFirst:
      '此 Host 的 Direct peer 連線正在使用中，請先在 Host 列表中將它停用。',
    enablePeerConnection: '開啟 Peer 連線',
    peerConnectionStarting: 'Peer 連線已開啟，Mesh endpoint 正在就緒',
    peerConnectionStartingHint: '通常只需幾秒；也可以立即重新檢查。',
    peerConnectionUpgradeRequired: '此 Runtime Host 版本尚不支援 Peer Mesh 管理',
    peerConnectionUpgradeRequiredHint: '請先更新此 Host，再回來開啟 Peer 連線。',
    working: {
      refresh: '正在重新整理 Peer Mesh…',
      create: '正在建立 Mesh…',
      join: '正在加入 Mesh…',
      invite: '正在準備邀請…',
      'add-host': '正在將 Runtime Host 加入 Mesh…',
      'enable-peer': '正在為 Runtime Host 開啟 Peer 連線…',
      update: '正在更新 Mesh…',
      rename: '正在儲存名稱…',
    },
    settling: '正在確認最終狀態…',
    endpoint: '管理對象',
    desktopEndpoint: 'Desktop Client',
    hostEndpoint: '本機 Runtime Host',
    desktopEndpointHelp: '此 Client 用於連線至 Mesh 中的 Runtime Host。',
    hostEndpointHelp: '此 Host 加入後，其他成員才能連線至本機分享的任務。',
    advancedSettings: '進階設定',
    technicalDetails: '身分與連線設定',
    connectivityAutomatic: '自動連線（建議）',
    connectivityKnownRoutesOnly: '僅使用已知路徑',
    connectivityCustom: '自訂位址探索',
    restartRequired: '需要重新啟動',
    adaptiveConnectivity: '自適應連線',
    adaptiveConnectivityHelp:
      'Maka 會自動競速可用的直接連線方式，並在獲准時使用成員轉送；此處不需要選擇特定通訊協定。',
    connectivityPolicyLoading: '正在讀取連線策略…',
    connectivityPolicyLoadFailed: '無法讀取連線策略',
    connectivityPolicySaveFailed: '無法儲存連線策略',
    restoreDefaultConnectivityPolicy: '恢復預設設定',
    connectivityPolicyRestartRequired:
      '重新啟動 Maka 後，已儲存的連線策略變更會套用至新連線。',
    publicAddressDiscovery: '公網位址探索',
    publicStunDefault: '公共 STUN（建議）',
    publicStunDisabled: '不使用公共 STUN',
    publicStunCustom: '自訂 STUN',
    customStunUrls: 'STUN 位址',
    customStunUrlsInvalid: '請輸入以逗號分隔的 stun:主機[:連接埠] 位址，最多 8 個。',
    publicStunDefaultHelp:
      '使用 Cloudflare 公共 STUN 盡力探索公網對映。它不承載 Maka 流量，但提供者可觀察來源 IP 和請求時間；Maka 不保證其可用性。',
    publicStunDisabledHelp:
      '僅嘗試本機位址和其他已知直接連線路徑；跨 NAT 的直接連線成功率可能降低。',
    publicStunCustomHelp:
      '使用逗號分隔的 stun: 位址。STUN 只探索網路位址，不承載 Session 內容。',
    saveConnectivityPolicy: '儲存變更',
    peerId: 'Peer ID',
    peerIdHelp: '此 endpoint 在 Mesh 中的技術身分；點選 ID 可複製完整值。',
    meshId: 'Mesh ID',
    meshIdHelp: '用於診斷和識別此 Mesh；點選 ID 可複製完整值。',
    thisRuntimeHost: '本機 Runtime Host',
    thisDesktop: '本機 Desktop',
    displayName: '在 Mesh 中顯示的名稱',
    meshDisplayName: 'Mesh 名稱',
    unnamedMesh: '未命名 Mesh',
    rename: '修改名稱',
    renameMesh: '修改 Mesh 名稱',
    save: '儲存',
    peerIdCopied: 'Peer ID 已複製',
    meshIdCopied: 'Mesh ID 已複製',
    copyPeerId: (value: string) => `複製完整 Peer ID：${value}`,
    copyMeshId: (value: string) => `複製完整 Mesh ID：${value}`,
    empty: '建立你的第一個 Mesh',
    emptyHint: '建立新的 Mesh，或透過一次性邀請碼加入。',
    meshes: 'Mesh',
    mesh: 'Mesh',
    members: '成員',
    activeMeshCount: (value: number) => `${value} 個使用中`,
    showClosedMeshes: (value: number) => `顯示已關閉（${value}）`,
    noActiveMeshes: '沒有使用中的 Mesh',
    noActiveMeshesHint: '已關閉的 Mesh 預設隱藏；可透過上方篩選查看。',
    authority: '管理者',
    member: '成員',
    closed: '已關閉',
    memberCount: (value: number) => `${value} 個成員`,
    pending: (value: number) => `${value} 個待使用邀請`,
    transit: '成員轉送',
    transitHelp: '允許此 Mesh 的成員透過本機建立連線；會使用本機頻寬。',
    transitToggle: '為此 Mesh 提供轉送',
    transitStatus: '成員轉送狀態',
    transitLimitsLabel: '成員轉送限制',
    transitLimits: (value: PeerMeshQueryResult['transit']) =>
      value
        ? `固定上限：每位成員 ${value.maxCircuitsPerPeer} 條連線，每條最長 ${formatHours(value.maxCircuitDurationSeconds)}，最多 ${formatMebibytes(value.maxCircuitBytes)}。一次只能為一個 Mesh 開啟。`
        : '成員轉送使用固定資源上限，一次只能為一個 Mesh 開啟。',
    allowedMembers: '允許成員',
    reservations: 'Reservation',
    circuits: '連線',
    routeState: {
      local: '本機',
      connecting: '正在連線',
      reachable: '可連線',
      reconnecting: '正在恢復連線',
      needs_repair: '需要新邀請碼修復',
    },
    endpointKind: {
      client: 'Client',
      host: 'Runtime Host',
      unknown: '未識別 Peer',
    },
    endpointKindHelp: {
      client: 'Client 是操作介面：它連線至 Host、瀏覽任務並發起操作，本身不持有任務。',
      host: 'Runtime Host 持有任務和執行狀態，並執行經過授權的工作。',
      unknown: '此 Peer 尚未回報它是 Client 或 Runtime Host，通常來自舊版本。',
    },
    joinTitle: '加入 Mesh',
    joinHint: '貼上另一個 Peer 產生的一次性邀請碼。',
    joinCode: '邀請碼',
    join: '加入',
    joinMesh: '加入 Mesh',
    invite: '邀請成員',
    invitationTitle: '邀請成員',
    invitationFor: (value: string) => `Mesh ${value}`,
    invitationWarning: '此代碼只能使用一次；取得代碼的人可以讓一個 peer 加入此 Mesh。',
    invitationDirectOnly:
      '尚未連線至協調節點。此邀請碼只包含直接位址，跨 NAT 時可能無法連線。',
    invitationExpires: (value: string) => `有效期限至 ${value}`,
    invitationCopied: '邀請碼已複製',
    copyInvitation: '複製邀請碼',
    create: '建立 Mesh',
    refresh: '重新整理',
    back: '返回',
    leave: '退出 Mesh',
    closeMesh: '關閉 Mesh',
    remove: '移除成員',
    cancel: '取消',
    closeConfirm: '關閉這個 Mesh？',
    leaveConfirm: '退出這個 Mesh？',
    removeConfirm: '移除這個成員？',
    meshActions: 'Mesh 操作',
    memberActions: (peerId: string) => `${peerId} 的操作`,
    addLocalHost: '新增本機 Runtime Host',
    localRuntimeHost: 'Runtime Host',
    localHostMissing: '本機 Runtime Host 尚未加入',
    localHostMissingHint: '加入後，其他成員才能透過此 Mesh 連線至本機分享的任務。',
  },
  en: {
    title: 'Peer Mesh',
    experimental: 'Experimental',
    failed: 'Peer Mesh operation failed',
    invalidResult: 'Peer Mesh returned an invalid result',
    unknownError: 'Peer Mesh operation failed',
    outcomeUnknown:
      'The Host may have completed this operation. Its current state was refreshed; review it before trying again.',
    invitationOutcomeUnknown:
      'The Host may have created an invitation, but its one-time code was not returned and cannot be recovered. It will expire automatically; review the pending invitation count before creating another.',
    outcomeUnknownRefreshFailed:
      'The Host may have completed this operation, but its current state could not be refreshed. Reconnect and refresh before trying again.',
    unavailable: 'Peer Mesh is unavailable for this endpoint',
    loading: 'Loading Mesh status…',
    checkingPeerConnection: "Checking this Runtime Host's peer connection…",
    peerConnectionDisabled: 'Peer connectivity is not enabled for this Runtime Host',
    peerConnectionDisabledHint:
      'Enable it so this Host can create or join Meshes. The existing SSH connection remains available.',
    peerConnectionDisableProfileFirst:
      "This Host's Direct peer connection is in use. Disable it in the Host list before changing the listener.",
    enablePeerConnection: 'Enable peer connectivity',
    peerConnectionStarting: 'Peer connectivity is enabled; the Mesh endpoint is starting',
    peerConnectionStartingHint: 'This normally takes a few seconds. You can also check again.',
    peerConnectionUpgradeRequired: 'This Runtime Host version cannot manage Peer Mesh',
    peerConnectionUpgradeRequiredHint: 'Update this Host before enabling peer connectivity.',
    working: {
      refresh: 'Refreshing Peer Mesh…',
      create: 'Creating Mesh…',
      join: 'Joining Mesh…',
      invite: 'Preparing invitation…',
      'add-host': 'Adding the Runtime Host to the Mesh…',
      'enable-peer': 'Enabling peer connectivity for the Runtime Host…',
      update: 'Updating Mesh…',
      rename: 'Saving name…',
    },
    settling: 'Confirming the final state…',
    endpoint: 'Manage endpoint',
    desktopEndpoint: 'Desktop Client',
    hostEndpoint: 'Local Runtime Host',
    desktopEndpointHelp: 'This Client connects to Runtime Hosts in the Mesh.',
    hostEndpointHelp: 'Add this Host so other members can reach tasks shared from this device.',
    advancedSettings: 'Advanced settings',
    technicalDetails: 'Identity and connectivity details',
    connectivityAutomatic: 'Automatic connectivity (recommended)',
    connectivityKnownRoutesOnly: 'Known routes only',
    connectivityCustom: 'Custom address discovery',
    restartRequired: 'Restart required',
    adaptiveConnectivity: 'Adaptive connectivity',
    adaptiveConnectivityHelp:
      'Maka races available direct paths automatically and uses approved member transit when needed. You do not choose a transport protocol here.',
    connectivityPolicyLoading: 'Loading connectivity policy…',
    connectivityPolicyLoadFailed: 'Could not load connectivity policy',
    connectivityPolicySaveFailed: 'Could not save connectivity policy',
    restoreDefaultConnectivityPolicy: 'Restore defaults',
    connectivityPolicyRestartRequired:
      'Restart Maka to apply saved connectivity-policy changes to new connections.',
    publicAddressDiscovery: 'Public address discovery',
    publicStunDefault: 'Public STUN (recommended)',
    publicStunDisabled: 'No public STUN',
    publicStunCustom: 'Custom STUN',
    customStunUrls: 'STUN addresses',
    customStunUrlsInvalid:
      'Enter up to 8 comma-separated stun:host[:port] addresses.',
    publicStunDefaultHelp:
      'Uses Cloudflare public STUN on a best-effort basis to discover public mappings. It never carries Maka traffic, but the provider can observe source IPs and request timing; Maka provides no availability guarantee.',
    publicStunDisabledHelp:
      'Only local addresses and other known direct paths are attempted; direct connectivity across NAT may be reduced.',
    publicStunCustomHelp:
      'Enter comma-separated stun: addresses. STUN discovers network addresses and never carries Session content.',
    saveConnectivityPolicy: 'Save changes',
    peerId: 'Peer ID',
    peerIdHelp: 'Technical identity for this endpoint. Select the ID to copy its full value.',
    meshId: 'Mesh ID',
    meshIdHelp: 'Used to identify and diagnose this Mesh. Select the ID to copy its full value.',
    thisRuntimeHost: 'This Runtime Host',
    thisDesktop: 'This Desktop',
    displayName: 'Name shown in the Mesh',
    meshDisplayName: 'Mesh name',
    unnamedMesh: 'Unnamed Mesh',
    rename: 'Rename',
    renameMesh: 'Rename Mesh',
    save: 'Save',
    peerIdCopied: 'Peer ID copied',
    meshIdCopied: 'Mesh ID copied',
    copyPeerId: (value: string) => `Copy full Peer ID: ${value}`,
    copyMeshId: (value: string) => `Copy full Mesh ID: ${value}`,
    empty: 'Build your first Mesh',
    emptyHint: 'Create a new Mesh or join one with a one-time invitation.',
    meshes: 'Meshes',
    mesh: 'Mesh',
    members: 'Members',
    activeMeshCount: (value: number) => `${value} active`,
    showClosedMeshes: (value: number) => `Show closed (${value})`,
    noActiveMeshes: 'No active Meshes',
    noActiveMeshesHint: 'Closed Meshes are hidden by default. Use the filter above to show them.',
    authority: 'Owner',
    member: 'Member',
    closed: 'Closed',
    memberCount: (value: number) => value === 1 ? '1 member' : `${value} members`,
    pending: (value: number) => `${value} pending invites`,
    transit: 'Member transit',
    transitHelp: 'Let members of this Mesh connect through this device using its bandwidth.',
    transitToggle: 'Provide transit for this Mesh',
    transitStatus: 'Member transit status',
    transitLimitsLabel: 'Member transit limits',
    transitLimits: (value: PeerMeshQueryResult['transit']) =>
      value
        ? `Fixed limits: ${value.maxCircuitsPerPeer} circuits per member, ${formatHours(value.maxCircuitDurationSeconds)} per circuit, and ${formatMebibytes(value.maxCircuitBytes)}. Only one Mesh can be served at a time.`
        : 'Member transit uses fixed resource limits. Only one Mesh can be served at a time.',
    allowedMembers: 'Allowed members',
    reservations: 'Reservations',
    circuits: 'Circuits',
    routeState: {
      local: 'Local',
      connecting: 'Connecting',
      reachable: 'Reachable',
      reconnecting: 'Reconnecting',
      needs_repair: 'Needs a new invitation',
    },
    endpointKind: {
      client: 'Client',
      host: 'Runtime Host',
      unknown: 'Unidentified peer',
    },
    endpointKindHelp: {
      client: 'A Client is the interface that connects to Hosts, browses tasks, and starts actions. It does not own tasks.',
      host: 'A Runtime Host owns tasks and runtime state, and executes authorized work.',
      unknown: 'This peer has not reported whether it is a Client or Runtime Host, usually because it uses an older build.',
    },
    joinTitle: 'Join a Mesh',
    joinHint: 'Paste a one-time invitation created by another peer.',
    joinCode: 'Invitation',
    join: 'Join',
    joinMesh: 'Join Mesh',
    invite: 'Invite member',
    invitationTitle: 'Invite a member',
    invitationFor: (value: string) => `Mesh ${value}`,
    invitationWarning:
      'This code works once. Anyone holding it can admit one peer to this Mesh.',
    invitationDirectOnly:
      'No coordination peer is available yet. This invitation contains direct routes only and may not work across NATs.',
    invitationExpires: (value: string) => `Expires ${value}`,
    invitationCopied: 'Invitation copied',
    copyInvitation: 'Copy invitation',
    create: 'Create Mesh',
    refresh: 'Refresh',
    back: 'Back',
    leave: 'Leave Mesh',
    closeMesh: 'Close Mesh',
    remove: 'Remove member',
    cancel: 'Cancel',
    closeConfirm: 'Close this Mesh?',
    leaveConfirm: 'Leave this Mesh?',
    removeConfirm: 'Remove this member?',
    meshActions: 'Mesh actions',
    memberActions: (peerId: string) => `Actions for ${peerId}`,
    addLocalHost: 'Add local Runtime Host',
    localRuntimeHost: 'Runtime Host',
    localHostMissing: 'Local Runtime Host has not joined',
    localHostMissingHint:
      'Add it so other members can reach tasks shared from this device through the Mesh.',
  },
} satisfies UiCatalog<PeerMeshCopy>;

export function getPeerMeshCopy(locale: UiLocale): PeerMeshCopy {
  return PEER_MESH_COPY[locale];
}

function formatHours(seconds: number): string {
  return `${seconds / 3_600}h`;
}

function formatMebibytes(bytes: number): string {
  return `${bytes / (1024 * 1024)} MiB`;
}
