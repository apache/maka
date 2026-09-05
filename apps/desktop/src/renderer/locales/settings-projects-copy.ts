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

export type SettingsProjectsCopy = {
  runtimeHost: {
    title: string;
    description: string;
    selected: string;
    selectedHelp: string;
    remoteTitle: string;
    remoteDescription: string;
    addComputer: string;
    useConnectionCode: string;
    useConnectionCodeDescription: string;
    addSshComputer: string;
    addSshComputerDescription: string;
    addWslEnvironment: string;
    addWslEnvironmentDescription: string;
    configureManually: string;
    configureManuallyDescription: string;
    thisComputerRemoteAccess: string;
    thisComputerRemoteAccessHelp: string;
    remoteAccessEnabling: string;
    remoteAccessOn: string;
    remoteAccessOff: string;
    enableRemoteAccess: string;
    disableRemoteAccess: string;
    disableRemoteAccessConfirm: string;
    disableRemoteAccessDescription: string;
    revokeSharedAccess: string;
    revokeSharedAccessConfirm: string;
    revokeSharedAccessDescription: string;
    revokeSharedAccessDone: string;
    createConnectionCode: string;
    connectionCodeTitle: string;
    connectionCodeDescription: string;
    importConnectionCodeTitle: string;
    importConnectionCodeDescription: string;
    connectionCodeHelpLabel: string;
    connectionCodeHelp: string;
    connectionCode: string;
    copyConnectionCode: string;
    pasteConnectionCode: string;
    connectionCodeCopied: string;
    connectionCodeInvalid: string;
    connectionCodeUnavailable: string;
    connectionCodeHostUnreachable: string;
    connectionCodeHostMismatch: string;
    connectionCodeUnknownError: string;
    connectWithCode: string;
    remoteAccessActiveTasks: string;
    remoteAccessActiveTasksDescription: string;
    uninstallActiveTasksDescription: string;
    interruptAndEnable: string;
    interruptAndUninstall: string;
    remoteAccessFailed: string;
    setupTitle: string;
    setupSshDescription: string;
    setupWslDescription: string;
    setupName: string;
    wslDistribution: string;
    setupSshPort: string;
    setupDirectoryRootsDescription: string;
    setupConnect: string;
    setupCancel: string;
    setupRetry: string;
    setupDone: string;
    setupChooseProject: string;
    setupComplete: string;
    setupPhase: Record<import('../../preload/bridge-contract.js').DesktopRuntimeHostOnboardingPhase, string>;
    add: string;
    cancel: string;
    name: string;
    nameHelp: string;
    transport: string;
    transportHelp: string;
    tls: string;
    ssh: string;
    plaintext: string;
    url: string;
    urlHelp: string;
    plaintextUrl: string;
    plaintextUrlHelp: string;
    sshDestination: string;
    sshDestinationHelp: string;
    sshPort: string;
    sshPortHelp: string;
    remotePort: string;
    remotePortHelp: string;
    websocketPath: string;
    websocketPathHelp: string;
    plaintextAcknowledgement: string;
    plaintextAcknowledgementHelp: string;
    plaintextWarning: string;
    sshTerminalTitle: string;
    sshTerminalDescription: string;
    sshTerminalClosed: string;
    sshTerminalClose: string;
    rootId: string;
    rootIdHelp: string;
    credential: string;
    credentialHelp: string;
    saveAndEnable: string;
    defaultBadge: string;
    experimentalBadge: string;
    defaultDisableHelp: string;
    unavailable: string;
    manage: string;
    managementTitle(name: string): string;
    serviceStatus: string;
    serviceState: Record<import('../../preload/bridge-contract.js').DesktopRuntimeHostManagementResult['service']['state'], string>;
    directPeer: string;
    directPeerDescription: string;
    directPeerState: Record<'unsupported' | 'not_configured' | 'disabled' | 'enabled' | 'unavailable', string>;
    directPeerUnavailable: string;
    directPeerUpgradeRequired: string;
    directPeerClientUnavailable: string;
    directPeerDisableProfileFirst: string;
    directPeerId: string;
    directPeerRoutes: string;
    directPeerCoordinationRelays: string;
    directPeerCoordinationRelaysPlaceholder: string;
    directPeerAdvancedCoordination: string;
    directPeerAdvancedNatTraversal: string;
    directPeerStunPolicy: string;
    directPeerStunPolicyOptions: {
      default: string;
      disabled: string;
      custom: string;
    };
    directPeerStunUrls: string;
    directPeerStunDefaultHelp: string;
    directPeerStunDisabledHelp: string;
    directPeerStunCustomHelp: string;
    directPeerAutomaticRelayDiscovery: string;
    directPeerAutomaticRelayDiscoveryHelp: string;
    directPeerEnable: string;
    directPeerDisable: string;
    directPeerAddProfile: string;
    directPeerActionFailed: string;
    peerMesh: string;
    peerMeshHelp: string;
    managePeerMesh: string;
    installedVersion: string;
    operatingSystem: string;
    processId: string;
    lastExitCode: string;
    stateRoot: string;
    directoryRoots: string;
    directoryRootsDescription: string;
    directoryRootsUnavailable: string;
    directoryRootsChanged: string;
    directoryRootsChangedDescription: string;
    reloadDirectoryRoots: string;
    noDirectoryRoots: string;
    directoryRootLabel: string;
    directoryRootPath: string;
    addDirectoryRoot: string;
    removeDirectoryRoot: string;
    saveDirectoryRoots: string;
    directoryRootsActiveTasks: string;
    directoryRootsActiveTasksDescription: string;
    configureDirectoriesInterrupt: string;
    refresh: string;
    startService: string;
    restartService: string;
    restartActiveTasksDescription: string;
    restartInterrupt: string;
    repairService: string;
    updateService: string;
    updatePolicy: string;
    updatePolicyDescription: string;
    updatePolicyManual: string;
    updatePolicyAutomatic: string;
    updatePolicyOptions: {
      manual: string;
      fixed: string;
      latest: string;
      next: string;
    };
    updatePolicyFixedVersion: string;
    updatePolicySave: string;
    updatePolicyCheckNow: string;
    updatePolicyUnavailable: string;
    updateSchedulerUnavailable: string;
    updateSchedulerUnavailableBody: string;
    updateSchedulerUnsupported: string;
    updateSchedulerInactive: string;
    updateSchedulerInactiveBody: string;
    updateSchedulerNeedsRepair: string;
    updateSchedulerNeedsRepairBody: string;
    updatePolicyDisabled: string;
    updatePolicyActiveTasks: string;
    updatePolicyNotNewer(version: string): string;
    updatePolicyManualAction(version: string): string;
    updatePolicyManualReason: Record<
      | 'current_compatibility_unknown'
      | 'target_compatibility_unknown'
      | 'compatibility_mismatch',
      string
    >;
    updatePhase: Record<
      'preparing_cli' | import('@maka/runtime-host/operator').RuntimeHostServiceUpdatePhase,
      string
    >;
    updateBlockedTitle: string;
    updateBlockedBody: string;
    updateInterrupt: string;
    updateComplete(from: string, to: string): string;
    updateRepaired(version: string): string;
    updateAlreadyCurrent(version: string): string;
    showLogs: string;
    noLogs: string;
    uninstallService: string;
    uninstallConfirmTitle: string;
    uninstallConfirmBody: string;
    uninstallConfirm: string;
    uninstallRetained(path: string): string;
    managementActionFailed: string;
    managementReconnectFailed: string;
    manageAccess: string;
    accessTitle: string;
    noAccessCredentials: string;
    currentDesktop: string;
    accessKind: {
      owner: string;
      capabilityProvider: string;
    };
    accessPending: string;
    accessCreated(date: string): string;
    rotateCredential: string;
    rotateCredentialConfirmTitle: string;
    rotateCredentialConfirmBody: string;
    rotateCredentialConfirm: string;
    enableBeforeRotate: string;
    startBeforeChangingAccess: string;
    revokeCredential: string;
    revokeCredentialConfirm(name: string): string;
    revokeCredentialConfirmBody: string;
    accessActionFailed: string;
    back: string;
    remove: string;
    empty: string;
    loadFailed: string;
    selectFailed: string;
    saveFailed: string;
    removeFailed: string;
    pairingRecoveryTitle: string;
    pairingRecoveryDescription: string;
    resolvePairingRecovery: string;
    resolvePairingRecoveryFailed: string;
    pairingPendingBadge: string;
    discardPairing: string;
    discardPairingConfirmTitle: string;
    discardPairingConfirmBody: string;
    discardPairingFailed: string;
    moreActions(name: string): string;
  };
  section: string;
  sectionHelp: string;
  addProject: string;
  defaultBadge: string;
  setDefault: string;
  setDefaultTitle: string;
  /** Why the control is disabled — a disabled control must say so itself. */
  setDefaultDisabledTitle: string;
  setDefaultFailed: string;
  rename: string;
  renameLabel: string;
  renameFailed: string;
  openFolder: string;
  openFolderFailed: string;
  save: string;
  cancel: string;
  clearDefault: string;
  remove: string;
  removeConfirmTitle: string;
  removeConfirmBody: string;
  removeConfirm: string;
  removeCancel: string;
  actionFailed: string;
  unavailable: string;
  /** Shown when the configured default no longer names a usable project. */
  defaultUnavailable: string;
  emptyTitle: string;
  emptyBody: string;
  /**
   * Names the row it belongs to. Four buttons all called 更多操作 are one
   * button as far as assistive tech is concerned — and they were equally
   * ambiguous to a test, which is how the ambiguity was noticed.
   */
  moreActions(projectName: string): string;
};

const SETTINGS_PROJECTS_COPY_BY_LOCALE = {
  'zh-CN': {
    runtimeHost: {
      title: 'Runtime Host',
      description: 'Local 与其他已启用的 Host 会同时保持连接；任务仍由其所属 Host 处理。',
      selected: '默认 Host',
      selectedHelp: '新任务和未指定 Host 的设置使用默认 Host',
      remoteTitle: '其他 Host',
      remoteDescription: '通过连接码或引导设置添加并管理其他 Runtime Host。',
      addComputer: '添加电脑',
      useConnectionCode: '使用连接码',
      useConnectionCodeDescription: '粘贴另一台电脑生成的一次性连接码',
      addSshComputer: '通过 SSH 设置',
      addSshComputerDescription: '在可通过 SSH 登录的电脑上安装并连接 Host',
      addWslEnvironment: '添加 WSL 环境',
      addWslEnvironmentDescription: '在这台 Windows 电脑的 WSL 中安装并连接 Host',
      configureManually: '手动配置',
      configureManuallyDescription: '为已有 Host 填写 TLS、SSH 或 Direct peer 参数',
      thisComputerRemoteAccess: '远程访问',
      thisComputerRemoteAccessHelp: '通过实验性端到端直连访问此 Host；可自动发现公共协调节点来辅助打洞',
      remoteAccessEnabling: '正在准备并开启远程访问；首次可能需要一点时间。',
      remoteAccessOn: '已开启',
      remoteAccessOff: '未开启',
      enableRemoteAccess: '开启',
      disableRemoteAccess: '关闭连接',
      disableRemoteAccessConfirm: '关闭远程连接？',
      disableRemoteAccessDescription: '这只会停止 Direct peer 连接；已授予的共享访问仍会保留。',
      revokeSharedAccess: '撤销共享访问',
      revokeSharedAccessConfirm: '撤销共享访问？',
      revokeSharedAccessDescription: '已连接的 Desktop 将断开，尚未使用的连接码也会失效。',
      revokeSharedAccessDone: '共享访问已撤销',
      createConnectionCode: '新建连接码',
      connectionCodeTitle: '连接这台电脑',
      connectionCodeDescription: '连接码将在 15 分钟后过期且只能使用一次。对方将获得 Owner 权限；Direct peer 无后备连接。',
      importConnectionCodeTitle: '使用连接码',
      importConnectionCodeDescription: '连接后将获得对方 Host 的 Owner 权限。Direct peer 无后备连接。',
      connectionCodeHelpLabel: '如何获得连接码',
      connectionCodeHelp: '在目标电脑的 Maka 中打开“设置 → 工作区 → 远程访问”，或打开已通过 SSH 管理的 Host 并选择“新建连接码”。也可在目标电脑运行 maka runtime-host access connection-code。连接码将在 15 分钟后过期且只能使用一次。',
      connectionCode: '连接码',
      copyConnectionCode: '复制连接码',
      pasteConnectionCode: '粘贴',
      connectionCodeCopied: '连接码已复制',
      connectionCodeInvalid: '连接码格式无效。',
      connectionCodeUnavailable: '连接码已过期或已被使用。请在另一台电脑上新建连接码。',
      connectionCodeHostUnreachable: '无法建立 Direct peer 连接。请确认两台电脑在线且网络允许 UDP。',
      connectionCodeHostMismatch: '连接码指向的 Host 与实际连接的 Host 不匹配或版本不兼容。',
      connectionCodeUnknownError: '连接结果未知。请先检查远程 Host 列表，再决定是否重试。',
      connectWithCode: '连接',
      remoteAccessActiveTasks: '这台电脑仍有正在运行的任务',
      remoteAccessActiveTasksDescription: '开启远程访问需要把 Local Host 交给系统服务。是否中断当前任务并继续？',
      uninstallActiveTasksDescription: '移除后台服务会停止当前任务。是否中断这些任务并继续？',
      interruptAndEnable: '中断任务并开启',
      interruptAndUninstall: '中断任务并移除',
      remoteAccessFailed: '远程访问操作失败',
      setupTitle: '添加 Runtime Host',
      setupSshDescription: '在可通过 SSH 登录的电脑上安装并连接 Runtime Host',
      setupWslDescription: '在本机 WSL 环境中安装并连接 Runtime Host',
      setupName: '显示名称（可选）',
      wslDistribution: 'WSL 发行版',
      setupSshPort: 'SSH 端口（可选）',
      setupDirectoryRootsDescription: '留空时使用远端 Home。添加目录后，只有这些目录可用于浏览并添加项目。',
      setupConnect: '连接',
      setupCancel: '取消',
      setupRetry: '重试',
      setupDone: '完成',
      setupChooseProject: '选择项目',
      setupComplete: 'Runtime Host 已连接',
      setupPhase: {
        preparing_cli: '正在准备本地 CLI…',
        connecting_ssh: '正在连接 SSH…',
        connecting_wsl: '正在连接 WSL 环境…',
        checking_environment: '正在检查远程环境…',
        installing_package: '正在安装 Maka…',
        installing_service: '正在启动 Runtime Host…',
        pairing_client: '正在配对这台设备…',
        verifying_connection: '正在验证凭据…',
        connecting_host: '正在建立安全连接…',
      },
      add: '添加远程 Host',
      cancel: '取消',
      name: '显示名称',
      nameHelp: '仅用于在这台设备上识别该 Host',
      transport: '连接方式',
      transportHelp: '优先使用 TLS；内网中可通过 SSH tunnel 连接仅监听本机的 Host',
      tls: 'TLS',
      ssh: 'SSH tunnel',
      plaintext: '明文 WebSocket',
      url: 'WSS 地址',
      urlHelp: '远程 Runtime Host 的 wss:// 地址',
      plaintextUrl: 'WS 地址',
      plaintextUrlHelp: '远程 Runtime Host 的 ws:// 地址',
      sshDestination: 'SSH 目标',
      sshDestinationHelp: 'OpenSSH 可识别的 user@host 或 SSH config 别名',
      sshPort: 'SSH 端口',
      sshPortHelp: '可选；留空使用 OpenSSH 默认值或 SSH config',
      remotePort: '远程 Host 端口',
      remotePortHelp: '远程 Runtime Host 在 127.0.0.1 上监听的 WebSocket 端口',
      websocketPath: 'WebSocket 路径',
      websocketPathHelp: '通常为 /runtime-host',
      plaintextAcknowledgement: '我了解明文连接的风险',
      plaintextAcknowledgementHelp: '访问凭据和数据可能被同一网络中的第三方截获',
      plaintextWarning: '仅在可信且隔离的网络中使用；公网连接应使用 TLS 或 SSH tunnel',
      sshTerminalTitle: '连接远程 Runtime Host',
      sshTerminalDescription: '按 OpenSSH 提示确认主机或输入密码。已有 SSH key 时通常无需操作。',
      sshTerminalClosed: 'SSH 连接已结束',
      sshTerminalClose: '关闭',
      rootId: 'State Root ID',
      rootIdHelp: '来自远程 service 的 ready 输出，用于确认连接的是预期 Host',
      credential: '访问凭据',
      credentialHelp: '在远程机器使用 desktop-client preset 签发',
      saveAndEnable: '保存并启用',
      defaultBadge: '默认',
      experimentalBadge: '实验性',
      defaultDisableHelp: '先选择另一个默认 Host，才能停用此 Host',
      unavailable: '无法连接',
      manage: '管理',
      managementTitle: (name: string) => `管理 ${name}`,
      serviceStatus: '服务状态',
      serviceState: {
        not_installed: '未安装',
        stopped: '已停止',
        starting: '正在启动',
        running: '运行中',
        failed: '启动失败',
      },
      directPeer: 'Direct peer（实验性）',
      directPeerDescription: '创建独立的实验性 Direct profile。可自动发现或手动指定协调节点来辅助打洞；受限 NAT 或被阻止的 UDP 仍可能使其不可达，且不会回退到中继传输。保留 SSH profile 用于手动恢复。',
      directPeerState: {
        unsupported: '需要更新',
        not_configured: '未配置',
        disabled: '已停用',
        enabled: '已启用',
        unavailable: '不可用',
      },
      directPeerUnavailable: '无法读取 Direct peer 状态',
      directPeerUpgradeRequired: '请先更新远程 Runtime Host，再管理 Direct peer。',
      directPeerClientUnavailable: '当前 Desktop 构建不包含 Direct peer 支持。',
      directPeerDisableProfileFirst: '请先在 Runtime Host 列表中停用 Direct peer。',
      directPeerId: 'Peer ID',
      directPeerRoutes: '可用路径',
      directPeerCoordinationRelays: '连接协调节点（可选）',
      directPeerCoordinationRelaysPlaceholder: '多个地址用逗号分隔',
      directPeerAdvancedCoordination: '手动设置协调节点',
      directPeerAdvancedNatTraversal: 'NAT 穿透（高级）',
      directPeerStunPolicy: '公网地址发现',
      directPeerStunPolicyOptions: {
        default: '公共 STUN（推荐）',
        disabled: '不使用公共 STUN',
        custom: '自定义 STUN',
      },
      directPeerStunUrls: 'STUN 地址',
      directPeerStunDefaultHelp:
        '使用 Cloudflare 公共 STUN 尽力发现公网映射。它不转发 Maka 流量，但提供方可观察源 IP 和请求时间；Maka 不保证其可用性。',
      directPeerStunDisabledHelp:
        '仅尝试本地地址和其他已知直连路径；跨 NAT 的直连成功率可能降低。',
      directPeerStunCustomHelp:
        '使用逗号分隔的 stun: 地址。STUN 只发现网络地址，不承载 Session 内容。',
      directPeerAutomaticRelayDiscovery: '自动发现协调节点',
      directPeerAutomaticRelayDiscoveryHelp:
        '协调节点使用 Circuit Relay v2 协议，仅帮助建立端到端直连，不承载应用流量。Maka 会通过公共 IPFS 网络尽力发现可用节点；手动设置的节点优先。',
      directPeerEnable: '启用并添加',
      directPeerDisable: '停用',
      directPeerAddProfile: '添加到 Desktop',
      directPeerActionFailed: 'Direct peer 操作失败',
      peerMesh: 'Peer Mesh',
      peerMeshHelp: '管理本 Desktop peer 的私有 Mesh membership 和邀请',
      managePeerMesh: '管理 Peer Mesh',
      installedVersion: '版本',
      operatingSystem: '系统',
      processId: '进程 ID',
      lastExitCode: '上次退出码',
      stateRoot: 'State Root',
      directoryRoots: '可用于添加项目的目录',
      directoryRootsDescription: '远程 Client 只能从这些目录浏览并添加新项目。移除目录不会删除已经添加的项目。',
      directoryRootsUnavailable: '更新或修复这个 Host 后，即可在 Desktop 中管理这些目录。',
      directoryRootsChanged: '这些目录已在其他位置更改',
      directoryRootsChangedDescription: '你的编辑仍被保留。加载当前配置后再继续编辑。',
      reloadDirectoryRoots: '加载当前配置',
      noDirectoryRoots: '目录浏览和项目添加已禁用',
      directoryRootLabel: '显示名称',
      directoryRootPath: '远端绝对路径',
      addDirectoryRoot: '添加目录',
      removeDirectoryRoot: '移除',
      saveDirectoryRoots: '应用目录',
      directoryRootsActiveTasks: '这个 Host 仍有正在运行的任务',
      directoryRootsActiveTasksDescription: '应用目录需要安全重启远端服务。只有明确确认后才会中断这些任务。',
      configureDirectoriesInterrupt: '中断任务并应用',
      refresh: '刷新',
      startService: '启动',
      restartService: '重启',
      restartActiveTasksDescription: '重启会停止当前任务。是否中断这些任务并继续？',
      restartInterrupt: '中断任务并重启',
      repairService: '修复',
      updateService: '安装配套版本',
      updatePolicy: '更新策略',
      updatePolicyDescription: '选择这个 Host 跟随的 Maka 版本',
      updatePolicyManual: '手动',
      updatePolicyAutomatic: '自动',
      updatePolicyOptions: {
        manual: '手动更新',
        fixed: '固定版本',
        latest: 'Latest 稳定频道',
        next: 'Next 预览频道',
      },
      updatePolicyFixedVersion: '版本',
      updatePolicySave: '保存策略',
      updatePolicyCheckNow: '立即检查',
      updatePolicyUnavailable: '无法读取自动更新策略',
      updateSchedulerUnavailable: '此 Runtime Host 尚不支持自动更新',
      updateSchedulerUnavailableBody: '请先更新或修复服务，再启用固定版本或发布频道',
      updateSchedulerUnsupported: '不支持',
      updateSchedulerInactive: '未运行',
      updateSchedulerInactiveBody: '更新调度器未在运行，请启动或修复服务后再启用自动更新',
      updateSchedulerNeedsRepair: '需要修复',
      updateSchedulerNeedsRepairBody: '更新调度器未在运行，请修复服务后再启用自动更新',
      updatePolicyDisabled: '自动更新已关闭',
      updatePolicyActiveTasks: 'Runtime Host 正在执行任务，本次更新已推迟',
      updatePolicyNotNewer: (version: string) => `Maka ${version} 不高于当前版本`,
      updatePolicyManualAction: (version: string) => `Maka ${version} 需要手动更新`,
      updatePolicyManualReason: {
        current_compatibility_unknown: '无法确认当前版本的存储兼容性',
        target_compatibility_unknown: '无法确认目标版本的存储兼容性',
        compatibility_mismatch: '目标版本需要手动处理存储兼容性',
      },
      updatePhase: {
        preparing_cli: '正在准备本地 CLI…',
        checking: '正在检查版本…',
        staging: '正在准备新版本…',
        retiring: '正在安全停止当前 Runtime Host…',
        replacing: '正在启动并验证新版本…',
      },
      updateBlockedTitle: 'Runtime Host 可能仍在执行任务',
      updateBlockedBody: '无法确认当前 Host 可以安全停止。继续更新会中断当前执行，但会保留可恢复的任务状态和无法确认的外部效果。',
      updateInterrupt: '中断任务并更新',
      updateComplete: (from: string, to: string) => `Runtime Host 已从 ${from} 更新到 ${to}`,
      updateRepaired: (version: string) => `Runtime Host ${version} 已恢复运行`,
      updateAlreadyCurrent: (version: string) => `Runtime Host 已是 ${version}`,
      showLogs: '查看日志',
      noLogs: '没有服务日志',
      uninstallService: '卸载服务',
      uninstallConfirmTitle: '卸载此 Runtime Host？',
      uninstallConfirmBody: '这会停止并移除 Maka 管理的服务与程序，但保留 State Root、项目和任务数据。当前 Desktop Profile 不会被删除。',
      uninstallConfirm: '卸载服务',
      uninstallRetained: (path: string) => `服务已卸载，数据保留在 ${path}`,
      managementActionFailed: '无法管理 Runtime Host 服务',
      managementReconnectFailed: '更改已应用，但 Desktop 未能重新连接',
      manageAccess: '管理访问权限',
      accessTitle: '访问权限',
      noAccessCredentials: '没有访问凭据',
      currentDesktop: '当前 Desktop',
      accessKind: {
        owner: '客户端访问',
        capabilityProvider: 'Capability Provider',
      },
      accessPending: '等待确认',
      accessCreated: (date: string) => `创建于 ${date}`,
      rotateCredential: '轮换凭据',
      rotateCredentialConfirmTitle: '轮换当前 Desktop 的凭据？',
      rotateCredentialConfirmBody: '轮换会重新连接这个 Runtime Host，并可能中断正在进行的工作。请先完成或暂停活跃任务。',
      rotateCredentialConfirm: '继续轮换',
      enableBeforeRotate: '请先启用这个 Runtime Host，再轮换当前 Desktop 的凭据。',
      startBeforeChangingAccess: '请先启动 Runtime Host 服务，再修改访问权限。',
      revokeCredential: '撤销',
      revokeCredentialConfirm: (name: string) => `撤销 ${name} 的访问权限？`,
      revokeCredentialConfirmBody: '使用此凭据的客户端会立即断开连接，并可能中断正在进行的工作。',
      accessActionFailed: '无法管理访问权限',
      back: '返回',
      remove: '移除',
      empty: '还没有远程 Host',
      loadFailed: '无法读取 Runtime Host profiles',
      selectFailed: '无法更新 Runtime Host',
      saveFailed: '无法保存 Runtime Host profile',
      removeFailed: '无法移除 Runtime Host profile',
      pairingRecoveryTitle: '有未完成的配对',
      pairingRecoveryDescription: '可在对应 Host 的菜单中重试；如果不再需要，也可以放弃配对并清理未完成的连接。',
      resolvePairingRecovery: '重试配对',
      resolvePairingRecoveryFailed: '无法处理配对恢复',
      pairingPendingBadge: '配对未完成',
      discardPairing: '放弃配对',
      discardPairingConfirmTitle: '放弃这次配对？',
      discardPairingConfirmBody: '将删除未完成的连接并清理本机保存的临时凭据。之后仍可使用新的邀请码重新加入。',
      discardPairingFailed: '无法放弃配对',
      moreActions: (name: string) => `更多操作：${name}`,
    },
    section: '工作区',
    // Says all three layers of the rule in one sentence, because a help line
    // that only mentions the default would leave the user guessing what
    // happens before they set one.
    sectionHelp: '新任务默认打开此项目；未设置时沿用上次使用的项目。任何任务都能在输入框旁临时切换。',
    addProject: '添加项目',
    defaultBadge: '默认',
    setDefault: '设为默认',
    setDefaultTitle: '新任务默认打开这个项目',
    setDefaultDisabledTitle: '目录不可用，无法设为默认',
    setDefaultFailed: '设置默认项目失败',
    rename: '重命名',
    renameLabel: '项目名称',
    renameFailed: '重命名失败',
    openFolder: '打开项目文件夹',
    // Says which of the two things went wrong, because the fix differs: a
    // missing folder is the user's to restore, a refusal to open is not.
    openFolderFailed: '打不开这个目录，它可能已被移动或删除',
    save: '保存',
    cancel: '取消',
    clearDefault: '取消默认',
    remove: '从 Maka 移除',
    removeConfirmTitle: '从 Maka 移除这个项目？',
    // The one thing a user actually fears here, stated first and plainly.
    removeConfirmBody: '仅从 Maka 的项目列表移除，磁盘上的文件不受影响。该项目下已有的任务会移到"未归属"分组，不会被删除。',
    removeConfirm: '移除',
    removeCancel: '取消',
    actionFailed: '操作失败',
    unavailable: '目录不可用',
    defaultUnavailable: '原来的默认项目已不可用，新任务暂时沿用上次使用的项目。',
    emptyTitle: '还没有项目',
    emptyBody: '添加一个项目目录后，新任务就能默认从它打开，侧边栏也会按项目归类任务。',
    moreActions: (projectName: string) => `更多操作：${projectName}`,
  },
  'zh-TW': {
    runtimeHost: {
      title: 'Runtime Host',
      description: 'Local 與啟用的遠端 Host 會同時保持連線；任務仍由其所屬 Host 處理。',
      selected: '預設 Host',
      selectedHelp: '新任務和未指定 Host 的設定使用預設 Host',
      remoteTitle: '遠端 Host',
      remoteDescription: '透過 SSH 自動設定一臺電腦，或手動連線已有 Runtime Host。',
      addComputer: '新增電腦',
      useConnectionCode: '使用連線碼', useConnectionCodeDescription: '貼上另一台電腦產生的一次性連線碼', pasteConnectionCode: '貼上', connectionCodeHelpLabel: '如何取得連線碼', connectionCodeHelp: '在目標電腦的 Maka 中開啟「設定 → 工作區 → 遠端存取」，或開啟已透過 SSH 管理的 Host 並選擇「新建連線碼」。也可在目標電腦執行 maka runtime-host access connection-code。連線碼將在 15 分鐘後過期且只能使用一次。', addSshComputer: '透過 SSH 設定', addSshComputerDescription: '在可透過 SSH 登入的電腦上安裝並連線 Host', addWslEnvironment: '新增 WSL 環境', addWslEnvironmentDescription: '在這台 Windows 電腦的 WSL 中安裝並連線 Host', setupSshDescription: '在可透過 SSH 登入的電腦上安裝並連線 Runtime Host', setupWslDescription: '在本機 WSL 環境中安裝並連線 Runtime Host', configureManuallyDescription: '為已有 Host 填寫 TLS、SSH 或 Direct peer 參數',
      configureManually: '手動設定',
      thisComputerRemoteAccess: '遠端存取',
      thisComputerRemoteAccessHelp: '透過實驗性端對端直接連線存取此 Host；可自動探索公用協調節點以協助穿透 NAT',
      remoteAccessOn: '已開啟',
      remoteAccessOff: '未開啟',
      enableRemoteAccess: '開啟',
      remoteAccessEnabling: '正在準備並開啟遠端存取；首次可能需要一點時間。',
      disableRemoteAccess: '關閉連線',
      disableRemoteAccessConfirm: '關閉遠端連線？',
      disableRemoteAccessDescription: '這只會停止 Direct peer 連線；已授予的分享存取權仍會保留。',
      revokeSharedAccess: '撤銷分享存取權',
      revokeSharedAccessConfirm: '撤銷分享存取權？',
      revokeSharedAccessDescription: '已連線的 Desktop 將中斷連線，尚未使用的連線碼也會失效。',
      revokeSharedAccessDone: '已撤銷分享存取權',
      createConnectionCode: '建立連線碼',
      connectionCodeTitle: '連線至這台電腦',
      connectionCodeDescription: '連線碼將於 15 分鐘後過期且只能使用一次。對方將取得 Owner 權限；Direct peer 沒有備援連線。',
      importConnectionCodeTitle: '使用連線碼',
      importConnectionCodeDescription: '連線後將取得對方 Host 的 Owner 權限。Direct peer 沒有備援連線。',
      connectionCode: '連線碼',
      copyConnectionCode: '複製連線碼',
      connectionCodeCopied: '已複製連線碼',
      connectionCodeInvalid: '連線碼格式無效。',
      connectionCodeUnavailable: '連線碼已過期或已被使用。請在另一台電腦上建立新的連線碼。',
      connectionCodeHostUnreachable: '無法建立 Direct peer 連線。請確認兩台電腦均在線上，且網路允許 UDP。',
      connectionCodeHostMismatch: '連線碼指向的 Host 與實際連線的 Host 不符，或版本不相容。',
      connectionCodeUnknownError: '連線結果不明。請先檢查遠端 Host 清單，再決定是否重試。',
      connectWithCode: '連線',
      remoteAccessActiveTasks: '這台電腦仍有執行中的任務',
      remoteAccessActiveTasksDescription: '開啟遠端存取需要將 Local Host 交由系統服務管理。是否中斷目前任務並繼續？',
      uninstallActiveTasksDescription: '移除背景服務會停止目前任務。是否中斷這些任務並繼續？',
      interruptAndEnable: '中斷任務並開啟',
      interruptAndUninstall: '中斷任務並移除',
      remoteAccessFailed: '遠端存取操作失敗',
      setupTitle: '新增遠端電腦',

      setupName: '顯示名稱（可選）',



      wslDistribution: 'WSL 發行版本',
      setupSshPort: 'SSH 埠（可選）',
      setupDirectoryRootsDescription: '留空時使用遠端 Home 資料夾。新增資料夾後，只能瀏覽這些位置以加入專案。',
      setupConnect: '連線',
      setupCancel: '取消',
      setupRetry: '重試',
      setupDone: '完成',
      setupChooseProject: '選擇專案',
      setupComplete: 'Runtime Host 已連線',
      setupPhase: {
        preparing_cli: '正在準備本地 CLI…',
        connecting_ssh: '正在連線 SSH…',
        connecting_wsl: '正在連線 WSL 環境…',
        checking_environment: '正在檢查遠端環境…',
        installing_package: '正在安裝 Maka…',
        installing_service: '正在啟動 Runtime Host…',
        pairing_client: '正在配對這臺裝置…',
        verifying_connection: '正在驗證憑據…',
        connecting_host: '正在建立安全連線…',
      },
      add: '新增遠端 Host',
      cancel: '取消',
      name: '顯示名稱',
      nameHelp: '僅用於在這臺裝置上識別該 Host',
      transport: '連線方式',
      transportHelp: '優先使用 TLS；內網中可透過 SSH tunnel 連線僅監聽本機的 Host',
      tls: 'TLS',
      ssh: 'SSH tunnel',
      plaintext: '明文 WebSocket',
      url: 'WSS 地址',
      urlHelp: '遠端 Runtime Host 的 wss:// 地址',
      plaintextUrl: 'WS 地址',
      plaintextUrlHelp: '遠端 Runtime Host 的 ws:// 地址',
      sshDestination: 'SSH 目標',
      sshDestinationHelp: 'OpenSSH 可識別的 user@host 或 SSH config 別名',
      sshPort: 'SSH 埠',
      sshPortHelp: '可選；留空使用 OpenSSH 預設值或 SSH config',
      remotePort: '遠端 Host 埠',
      remotePortHelp: '遠端 Runtime Host 在 127.0.0.1 上監聽的 WebSocket 埠',
      websocketPath: 'WebSocket 路徑',
      websocketPathHelp: '通常為 /runtime-host',
      plaintextAcknowledgement: '我瞭解明文連線的風險',
      plaintextAcknowledgementHelp: '存取憑據和資料可能被同一網路中的第三方截獲',
      plaintextWarning: '僅在可信且隔離的網路中使用；公網連線應使用 TLS 或 SSH tunnel',
      sshTerminalTitle: '連線遠端 Runtime Host',
      sshTerminalDescription: '按 OpenSSH 提示確認主機或輸入密碼。已有 SSH key 時通常無需操作。',
      sshTerminalClosed: 'SSH 連線已結束',
      sshTerminalClose: '關閉',
      rootId: 'State Root ID',
      rootIdHelp: '來自遠端 service 的 ready 輸出，用於確認連線的是預期 Host',
      credential: '存取憑據',
      credentialHelp: '在遠端機器使用 desktop-client preset 簽發',
      saveAndEnable: '儲存並啟用',
      defaultBadge: '預設',
      defaultDisableHelp: '先選擇另一個預設 Host，才能停用此 Host',
      unavailable: '無法連線',
      manage: '管理',
      managementTitle: (name: string) => `管理 ${name}`,
      serviceStatus: '服務狀態',
      serviceState: {
        not_installed: '未安裝',
        stopped: '已停止',
        starting: '正在啟動',
        running: '執行中',
        failed: '啟動失敗',
      },
      experimentalBadge: '實驗性',
      directPeer: 'Direct peer（實驗性）',
      directPeerDescription: '建立獨立的實驗性 Direct profile。受限 NAT 或遭封鎖的 UDP 可能導致無法連線，且不會自動回退；請保留 SSH profile 以便手動復原。',
      directPeerState: {
        unsupported: '需要更新', not_configured: '未設定', disabled: '已停用', enabled: '已啟用', unavailable: '無法使用',
      },
      directPeerUnavailable: '無法讀取 Direct peer 狀態',
      directPeerUpgradeRequired: '請先更新遠端 Runtime Host，再管理 Direct peer。',
      directPeerClientUnavailable: '目前 Desktop 建置不包含 Direct peer 支援。',
      directPeerDisableProfileFirst: '請先在 Runtime Host 清單中停用 Direct peer。',
      directPeerId: 'Peer ID', directPeerRoutes: '可用路徑',
      directPeerCoordinationRelays: '連線協調節點（可選）',
      directPeerCoordinationRelaysPlaceholder: '多個位址請以逗號分隔',
      directPeerAdvancedCoordination: '手動設定協調節點',
      directPeerAdvancedNatTraversal: 'NAT 穿透（進階）',
      directPeerStunPolicy: '公網位址探索',
      directPeerStunPolicyOptions: {
        default: '公共 STUN（建議）',
        disabled: '不使用公共 STUN',
        custom: '自訂 STUN',
      },
      directPeerStunUrls: 'STUN 位址',
      directPeerStunDefaultHelp:
        '使用 Cloudflare 公共 STUN 盡力探索公網對映。它不轉送 Maka 流量，但提供者可觀察來源 IP 和請求時間；Maka 不保證其可用性。',
      directPeerStunDisabledHelp:
        '僅嘗試本機位址和其他已知直接連線路徑；跨 NAT 的直接連線成功率可能降低。',
      directPeerStunCustomHelp:
        '使用逗號分隔的 stun: 位址。STUN 只探索網路位址，不承載 Session 內容。',
      directPeerAutomaticRelayDiscovery: '自動探索協調節點',
      directPeerAutomaticRelayDiscoveryHelp:
        '協調節點使用 Circuit Relay v2 通訊協定，只協助建立端對端直接連線，不承載應用程式流量。Maka 會透過公用 IPFS 網路盡力探索可用節點；手動設定的節點優先。',
      directPeerEnable: '啟用並新增', directPeerDisable: '停用', directPeerAddProfile: '新增至 Desktop',
      directPeerActionFailed: 'Direct peer 操作失敗',
      peerMesh: 'Peer Mesh',
      peerMeshHelp: '管理此 Desktop peer 的私人 Mesh 成員資格和邀請',
      managePeerMesh: '管理 Peer Mesh',
      installedVersion: '版本',
      operatingSystem: '系統',
      processId: '程序 ID',
      lastExitCode: '上次退出碼',
      stateRoot: 'State Root',
      directoryRoots: '可用目錄',
      directoryRootsDescription: '遠端用戶端只能從這些資料夾瀏覽並新增專案。移除資料夾不會刪除已新增的專案。',
      directoryRootsUnavailable: '更新或修復此 Host 後，即可在 Desktop 管理這些資料夾。',
      directoryRootsChanged: '這些資料夾已在其他位置變更',
      directoryRootsChangedDescription: '你的編輯內容仍會保留。請先載入目前設定，再繼續編輯。',
      reloadDirectoryRoots: '載入目前設定',
      noDirectoryRoots: '未設定額外目錄',
      directoryRootLabel: '標籤',
      directoryRootPath: '遠端絕對路徑',
      addDirectoryRoot: '新增資料夾',
      removeDirectoryRoot: '移除',
      saveDirectoryRoots: '套用資料夾',
      directoryRootsActiveTasks: '此 Host 仍有執行中的任務',
      directoryRootsActiveTasksDescription: '套用資料夾需要安全地重新啟動遠端服務。只有在明確確認後，才會中斷這些任務。',
      configureDirectoriesInterrupt: '中斷任務並套用',
      refresh: '重新整理',
      startService: '啟動',
      restartService: '重啟',
      restartActiveTasksDescription: '重新啟動會停止目前任務。是否中斷這些任務並繼續？',
      restartInterrupt: '中斷任務並重啟',
      repairService: '修復',
      updateService: '安裝配套版本',
      updatePolicy: '更新策略',
      updatePolicyDescription: '選擇這個 Host 跟隨的 Maka 版本',
      updatePolicyManual: '手動',
      updatePolicyAutomatic: '自動',
      updatePolicyOptions: {
        manual: '手動更新',
        fixed: '固定版本',
        latest: 'Latest 穩定頻道',
        next: 'Next 預覽頻道',
      },
      updatePolicyFixedVersion: '版本',
      updatePolicySave: '儲存策略',
      updatePolicyCheckNow: '立即檢查',
      updatePolicyUnavailable: '無法讀取自動更新策略',
      updateSchedulerUnavailable: '此 Runtime Host 尚不支援自動更新',
      updateSchedulerUnavailableBody: '請先更新或修復服務，再啟用固定版本或釋出頻道',
      updateSchedulerUnsupported: '不支援',
      updateSchedulerInactive: '未執行',
      updateSchedulerInactiveBody: '更新排程器未在執行，請啟動或修復服務後再啟用自動更新',
      updateSchedulerNeedsRepair: '需要修復',
      updateSchedulerNeedsRepairBody: '更新排程器未在執行，請修復服務後再啟用自動更新',
      updatePolicyDisabled: '自動更新已關閉',
      updatePolicyActiveTasks: 'Runtime Host 正在執行任務，本次更新已推遲',
      updatePolicyNotNewer: (version: string) => `Maka ${version} 不高於目前版本`,
      updatePolicyManualAction: (version: string) => `Maka ${version} 需要手動更新`,
      updatePolicyManualReason: {
        current_compatibility_unknown: '無法確認目前版本的儲存相容性',
        target_compatibility_unknown: '無法確認目標版本的儲存相容性',
        compatibility_mismatch: '目標版本需要手動處理儲存相容性',
      },
      updatePhase: {
        preparing_cli: '正在準備本地 CLI…',
        checking: '正在檢查版本…',
        staging: '正在準備新版本…',
        retiring: '正在安全停止目前 Runtime Host…',
        replacing: '正在啟動並驗證新版本…',
      },
      updateBlockedTitle: 'Runtime Host 可能仍在執行任務',
      updateBlockedBody: '無法確認目前 Host 可以安全停止。繼續更新會中斷目前執行，但會保留可恢復的任務狀態和無法確認的外部效果。',
      updateInterrupt: '中斷任務並更新',
      updateComplete: (from: string, to: string) => `Runtime Host 已從 ${from} 更新到 ${to}`,
      updateRepaired: (version: string) => `Runtime Host ${version} 已恢復執行`,
      updateAlreadyCurrent: (version: string) => `Runtime Host 已是 ${version}`,
      showLogs: '檢視記錄',
      noLogs: '沒有服務記錄',
      uninstallService: '解除安裝服務',
      uninstallConfirmTitle: '解除安裝遠端 Runtime Host？',
      uninstallConfirmBody: '這會停止並移除 Maka 管理的服務與程式，但保留 State Root、專案和任務資料。目前 Desktop Profile 不會被刪除。',
      uninstallConfirm: '解除安裝服務',
      uninstallRetained: (path: string) => `服務已解除安裝，資料保留在 ${path}`,
      managementActionFailed: '無法管理 Runtime Host 服務',
      managementReconnectFailed: '變更已套用，但 Desktop 無法重新連線',
      manageAccess: '管理存取權限',
      accessTitle: '存取權限',
      noAccessCredentials: '沒有存取憑據',
      currentDesktop: '目前 Desktop',
      accessKind: {
        owner: '客戶端存取',
        capabilityProvider: 'Capability Provider',
      },
      accessPending: '等待確認',
      accessCreated: (date: string) => `建立於 ${date}`,
      rotateCredential: '輪換憑據',
      rotateCredentialConfirmTitle: '輪換目前 Desktop 的憑據？',
      rotateCredentialConfirmBody: '輪換會重新連線這個 Runtime Host，並可能中斷正在進行的工作。請先完成或暫停活躍任務。',
      rotateCredentialConfirm: '繼續輪換',
      enableBeforeRotate: '請先啟用這個 Runtime Host，再輪換目前 Desktop 的憑據。',
      startBeforeChangingAccess: '請先啟動 Runtime Host 服務，再修改存取權限。',
      revokeCredential: '撤銷',
      revokeCredentialConfirm: (name: string) => `撤銷 ${name} 的存取權限？`,
      revokeCredentialConfirmBody: '使用此憑據的客戶端會立即斷開連線，並可能中斷正在進行的工作。',
      accessActionFailed: '無法管理存取權限',
      back: '返回',
      remove: '移除',
      empty: '還沒有遠端 Host',
      loadFailed: '無法讀取 Runtime Host profiles',
      selectFailed: '無法更新 Runtime Host',
      saveFailed: '無法儲存 Runtime Host profile',
      removeFailed: '無法移除 Runtime Host profile',
      pairingRecoveryTitle: '有未完成的配對',
      pairingRecoveryDescription: '可在對應 Host 的選單中重試；如果不再需要，也可以放棄配對並清理未完成的連線。',
      resolvePairingRecovery: '重試配對',
      resolvePairingRecoveryFailed: '無法處理配對恢復',
      pairingPendingBadge: '配對未完成',
      discardPairing: '放棄配對',
      discardPairingConfirmTitle: '放棄這次配對？',
      discardPairingConfirmBody: '這會刪除未完成的連線，並清理儲存在本機的暫時憑證。之後仍可使用新的邀請碼重新加入。',
      discardPairingFailed: '無法放棄配對',
      moreActions: (name: string) => `更多操作：${name}`,
    },
    section: '工作區',
    // Says all three layers of the rule in one sentence, because a help line
    // that only mentions the default would leave the user guessing what
    // happens before they set one.
    sectionHelp: '新任務預設開啟此專案；未設定時沿用上次使用的專案。任何任務都能在輸入框旁臨時切換。',
    addProject: '新增專案',
    defaultBadge: '預設',
    setDefault: '設為預設',
    setDefaultTitle: '新任務預設開啟這個專案',
    setDefaultDisabledTitle: '目錄不可用，無法設為預設',
    setDefaultFailed: '設定預設專案失敗',
    rename: '重新命名',
    renameLabel: '專案名稱',
    renameFailed: '重新命名失敗',
    openFolder: '開啟專案資料夾',
    // Says which of the two things went wrong, because the fix differs: a
    // missing folder is the user's to restore, a refusal to open is not.
    openFolderFailed: '打不開這個目錄，它可能已被移動或刪除',
    save: '儲存',
    cancel: '取消',
    clearDefault: '取消預設',
    remove: '從 Maka 移除',
    removeConfirmTitle: '從 Maka 移除這個專案？',
    // The one thing a user actually fears here, stated first and plainly.
    removeConfirmBody: '僅從 Maka 的專案列表移除，磁碟上的檔案不受影響。該專案下已有的任務會移到"未歸屬"分組，不會被刪除。',
    removeConfirm: '移除',
    removeCancel: '取消',
    actionFailed: '操作失敗',
    unavailable: '目錄不可用',
    defaultUnavailable: '原來的預設專案已不可用，新任務暫時沿用上次使用的專案。',
    emptyTitle: '還沒有專案',
    emptyBody: '新增一個專案目錄後，新任務就能預設從它開啟，側邊欄也會按專案歸類任務。',
    moreActions: (projectName: string) => `更多操作：${projectName}`,
  },
  en: {
    runtimeHost: {
      title: 'Runtime Host',
      description: 'Local and other enabled Hosts stay connected together. Each task remains owned by its Host.',
      selected: 'Default Host',
      selectedHelp: 'New tasks and unscoped settings use the default Host',
      remoteTitle: 'Other Hosts',
      remoteDescription: 'Add and manage Runtime Hosts with a connection code or guided setup.',
      addComputer: 'Add computer',
      useConnectionCode: 'Use connection code',
      useConnectionCodeDescription: 'Paste a one-time code created on another computer',
      addSshComputer: 'Set up over SSH',
      addSshComputerDescription: 'Install and connect a Host on a computer you can access with SSH',
      addWslEnvironment: 'Add WSL environment',
      addWslEnvironmentDescription: 'Install and connect a Host inside WSL on this Windows computer',
      configureManually: 'Configure manually',
      configureManuallyDescription: 'Enter TLS, SSH, or Direct peer details for an existing Host',
      thisComputerRemoteAccess: 'Remote access',
      thisComputerRemoteAccessHelp: 'Reach this Host through experimental end-to-end direct connections, with automatic public coordination discovery',
      remoteAccessEnabling: 'Preparing and enabling remote access. The first setup may take a moment.',
      remoteAccessOn: 'On',
      remoteAccessOff: 'Off',
      enableRemoteAccess: 'Enable',
      disableRemoteAccess: 'Turn off connectivity',
      disableRemoteAccessConfirm: 'Turn off remote connectivity?',
      disableRemoteAccessDescription: 'This only stops Direct peer connectivity. Granted shared access is retained.',
      revokeSharedAccess: 'Revoke shared access',
      revokeSharedAccessConfirm: 'Revoke shared access?',
      revokeSharedAccessDescription: 'The connected Desktop will be disconnected, and unused connection codes will stop working.',
      revokeSharedAccessDone: 'Shared access revoked',
      createConnectionCode: 'New connection code',
      connectionCodeTitle: 'Connect to this computer',
      connectionCodeDescription: 'Expires in 15 minutes and can be used once. The other Desktop receives Owner access. Direct peer has no fallback.',
      importConnectionCodeTitle: 'Use a connection code',
      importConnectionCodeDescription: 'Connecting grants this Desktop Owner access to the other Host. Direct peer has no fallback.',
      connectionCodeHelpLabel: 'How to get a connection code',
      connectionCodeHelp: 'On the target computer, open Maka Settings → Workspace → Remote access, or open an SSH-managed Host and choose New connection code. You can also run maka runtime-host access connection-code on the target computer. A code expires after 15 minutes and works once.',
      connectionCode: 'Connection code',
      copyConnectionCode: 'Copy connection code',
      pasteConnectionCode: 'Paste',
      connectionCodeCopied: 'Connection code copied',
      connectionCodeInvalid: 'The connection code is invalid.',
      connectionCodeUnavailable: 'The connection code expired or was already used. Create a new code on the other computer.',
      connectionCodeHostUnreachable: 'A Direct peer connection could not be established. Check that both computers are online and UDP is allowed.',
      connectionCodeHostMismatch: 'The code does not match the connected Host, or the Host version is incompatible.',
      connectionCodeUnknownError: 'The connection outcome is unknown. Check the remote Host list before retrying.',
      connectWithCode: 'Connect',
      remoteAccessActiveTasks: 'This computer still has running tasks',
      remoteAccessActiveTasksDescription: 'Enabling remote access hands the Local Host to a system service. Interrupt the current tasks and continue?',
      uninstallActiveTasksDescription: 'Removing the background service stops the current tasks. Interrupt them and continue?',
      interruptAndEnable: 'Interrupt and enable',
      interruptAndUninstall: 'Interrupt and remove',
      remoteAccessFailed: 'Remote access failed',
      setupTitle: 'Add Runtime Host',
      setupSshDescription: 'Install and connect Runtime Host on a computer available over SSH',
      setupWslDescription: 'Install and connect Runtime Host in a local WSL environment',
      setupName: 'Display name (optional)',
      wslDistribution: 'WSL distribution',
      setupSshPort: 'SSH port (optional)',
      setupDirectoryRootsDescription: 'Leave empty to use the remote Home directory. When directories are added, only those locations can be browsed to add projects.',
      setupConnect: 'Connect',
      setupCancel: 'Cancel',
      setupRetry: 'Retry',
      setupDone: 'Done',
      setupChooseProject: 'Choose project',
      setupComplete: 'Runtime Host connected',
      setupPhase: {
        preparing_cli: 'Preparing the local CLI…',
        connecting_ssh: 'Connecting over SSH…',
        connecting_wsl: 'Connecting to the WSL environment…',
        checking_environment: 'Checking the remote environment…',
        installing_package: 'Installing Maka…',
        installing_service: 'Starting Runtime Host…',
        pairing_client: 'Pairing this device…',
        verifying_connection: 'Verifying access…',
        connecting_host: 'Establishing the secure connection…',
      },
      add: 'Add remote Host',
      cancel: 'Cancel',
      name: 'Display name',
      nameHelp: 'Used only to identify this Host on this device',
      transport: 'Connection method',
      transportHelp: 'Prefer TLS, or use an SSH tunnel to reach a loopback-only Host on a private machine',
      tls: 'TLS',
      ssh: 'SSH tunnel',
      plaintext: 'Plain WebSocket',
      url: 'WSS URL',
      urlHelp: 'The wss:// address of the remote Runtime Host',
      plaintextUrl: 'WS URL',
      plaintextUrlHelp: 'The ws:// address of the remote Runtime Host',
      sshDestination: 'SSH destination',
      sshDestinationHelp: 'An OpenSSH user@host destination or SSH config alias',
      sshPort: 'SSH port',
      sshPortHelp: 'Optional; leave empty to use the OpenSSH default or SSH config',
      remotePort: 'Remote Host port',
      remotePortHelp: 'WebSocket port where Runtime Host listens on 127.0.0.1 remotely',
      websocketPath: 'WebSocket path',
      websocketPathHelp: 'Usually /runtime-host',
      plaintextAcknowledgement: 'I understand the plaintext risk',
      plaintextAcknowledgementHelp: 'Access credentials and data may be intercepted by others on the network',
      plaintextWarning: 'Use only on a trusted, isolated network. Public connections should use TLS or an SSH tunnel.',
      sshTerminalTitle: 'Connect to remote Runtime Host',
      sshTerminalDescription: 'Follow the OpenSSH prompt to trust the Host or enter a password. Existing SSH keys normally need no input.',
      sshTerminalClosed: 'The SSH connection ended',
      sshTerminalClose: 'Close',
      rootId: 'State Root ID',
      rootIdHelp: 'Copied from the remote service ready output to verify the expected Host',
      credential: 'Access credential',
      credentialHelp: 'Issue it on the remote machine with the desktop-client preset',
      saveAndEnable: 'Save and enable',
      defaultBadge: 'Default',
      experimentalBadge: 'Experimental',
      defaultDisableHelp: 'Choose another default Host before disabling this Host',
      unavailable: 'Unavailable',
      manage: 'Manage',
      managementTitle: (name: string) => `Manage ${name}`,
      serviceStatus: 'Service status',
      serviceState: {
        not_installed: 'Not installed',
        stopped: 'Stopped',
        starting: 'Starting',
        running: 'Running',
        failed: 'Failed',
      },
      directPeer: 'Direct peer (experimental)',
      directPeerDescription: 'Create an independent experimental Direct profile. Discover coordination peers automatically or provide them manually to assist hole punching; restrictive NAT or blocked UDP may still make it unreachable, and traffic does not fall back to a relay. Keep the SSH profile for manual recovery.',
      directPeerState: {
        unsupported: 'Update required',
        not_configured: 'Not configured',
        disabled: 'Disabled',
        enabled: 'Enabled',
        unavailable: 'Unavailable',
      },
      directPeerUnavailable: 'Direct peer status is unavailable',
      directPeerUpgradeRequired: 'Update the remote Runtime Host before managing Direct peer.',
      directPeerClientUnavailable: 'This Desktop build does not include Direct peer support.',
      directPeerDisableProfileFirst: 'Disable the Direct peer in the Runtime Host list first.',
      directPeerId: 'Peer ID',
      directPeerRoutes: 'Routes',
      directPeerCoordinationRelays: 'Connection coordination peers (optional)',
      directPeerCoordinationRelaysPlaceholder: 'Separate multiple addresses with commas',
      directPeerAdvancedCoordination: 'Set coordination peers manually',
      directPeerAdvancedNatTraversal: 'NAT traversal (advanced)',
      directPeerStunPolicy: 'Public address discovery',
      directPeerStunPolicyOptions: {
        default: 'Public STUN (recommended)',
        disabled: 'No public STUN',
        custom: 'Custom STUN',
      },
      directPeerStunUrls: 'STUN addresses',
      directPeerStunDefaultHelp:
        'Uses Cloudflare public STUN on a best-effort basis to discover public mappings. It never carries Maka traffic, but the provider can observe source IPs and request timing; Maka provides no availability guarantee.',
      directPeerStunDisabledHelp:
        'Only local addresses and other known direct paths are attempted; direct connectivity across NAT may be reduced.',
      directPeerStunCustomHelp:
        'Enter comma-separated stun: addresses. STUN discovers network addresses and never carries Session content.',
      directPeerAutomaticRelayDiscovery: 'Discover coordination peers automatically',
      directPeerAutomaticRelayDiscoveryHelp:
        'Coordination peers use Circuit Relay v2 only to establish an end-to-end direct connection; they never carry application traffic. Maka discovers candidates through the public IPFS network on a best-effort basis, while manually configured peers remain preferred.',
      directPeerEnable: 'Enable and add',
      directPeerDisable: 'Disable',
      directPeerAddProfile: 'Add to Desktop',
      directPeerActionFailed: 'Direct peer action failed',
      peerMesh: 'Peer Mesh',
      peerMeshHelp: 'Manage private Mesh memberships and invitations for this Desktop peer',
      managePeerMesh: 'Manage Peer Mesh',
      installedVersion: 'Version',
      operatingSystem: 'System',
      processId: 'Process ID',
      lastExitCode: 'Last exit code',
      stateRoot: 'State Root',
      directoryRoots: 'Directories for adding projects',
      directoryRootsDescription: 'Remote Clients can browse and add new projects only from these directories. Removing one does not delete projects already added.',
      directoryRootsUnavailable: 'Update or repair this Host to manage these directories in Desktop.',
      directoryRootsChanged: 'These directories changed elsewhere',
      directoryRootsChangedDescription: 'Your draft is preserved. Load the current configuration before continuing.',
      reloadDirectoryRoots: 'Load current configuration',
      noDirectoryRoots: 'Directory browsing and project registration are disabled',
      directoryRootLabel: 'Display name',
      directoryRootPath: 'Absolute path on remote computer',
      addDirectoryRoot: 'Add directory',
      removeDirectoryRoot: 'Remove',
      saveDirectoryRoots: 'Apply directories',
      directoryRootsActiveTasks: 'This Host still has running tasks',
      directoryRootsActiveTasksDescription: 'Applying these directories requires a safe remote service restart. Tasks are interrupted only after explicit confirmation.',
      configureDirectoriesInterrupt: 'Interrupt tasks and apply',
      refresh: 'Refresh',
      startService: 'Start',
      restartService: 'Restart',
      restartActiveTasksDescription: 'Restarting stops the current tasks. Interrupt them and continue?',
      restartInterrupt: 'Interrupt tasks and restart',
      repairService: 'Repair',
      updateService: 'Install matching version',
      updatePolicy: 'Update policy',
      updatePolicyDescription: 'Choose which Maka release this Host follows',
      updatePolicyManual: 'Manual',
      updatePolicyAutomatic: 'Automatic',
      updatePolicyOptions: {
        manual: 'Manual updates',
        fixed: 'Fixed version',
        latest: 'Latest stable channel',
        next: 'Next preview channel',
      },
      updatePolicyFixedVersion: 'Version',
      updatePolicySave: 'Save policy',
      updatePolicyCheckNow: 'Check now',
      updatePolicyUnavailable: 'Automatic update policy is unavailable',
      updateSchedulerUnavailable: 'Automatic updates are not available on this Runtime Host',
      updateSchedulerUnavailableBody:
        'Update or repair the service before choosing a fixed version or release channel',
      updateSchedulerUnsupported: 'Unsupported',
      updateSchedulerInactive: 'Inactive',
      updateSchedulerInactiveBody:
        'The update scheduler is not running. Start or repair the service before enabling automatic updates',
      updateSchedulerNeedsRepair: 'Needs repair',
      updateSchedulerNeedsRepairBody:
        'The update scheduler is not running. Repair the service before enabling automatic updates',
      updatePolicyDisabled: 'Automatic updates are off',
      updatePolicyActiveTasks: 'Runtime Host owns active work, so this update was deferred',
      updatePolicyNotNewer: (version: string) => `Maka ${version} is not newer than this Host`,
      updatePolicyManualAction: (version: string) => `Maka ${version} needs a manual update`,
      updatePolicyManualReason: {
        current_compatibility_unknown: 'The installed version has unknown storage compatibility',
        target_compatibility_unknown: 'The target version has unknown storage compatibility',
        compatibility_mismatch: 'The target requires a manual storage compatibility decision',
      },
      updatePhase: {
        preparing_cli: 'Preparing the local CLI…',
        checking: 'Checking versions…',
        staging: 'Staging the new version…',
        retiring: 'Safely stopping the current Runtime Host…',
        replacing: 'Starting and verifying the new version…',
      },
      updateBlockedTitle: 'Runtime Host may still own active work',
      updateBlockedBody: 'Desktop could not prove that the current Host can stop safely. Continuing will interrupt current execution while preserving recoverable task state and unresolved external effects.',
      updateInterrupt: 'Interrupt and update',
      updateComplete: (from: string, to: string) => `Runtime Host was updated from ${from} to ${to}`,
      updateRepaired: (version: string) => `Runtime Host ${version} is running again`,
      updateAlreadyCurrent: (version: string) => `Runtime Host is already on ${version}`,
      showLogs: 'View logs',
      noLogs: 'No service logs were found',
      uninstallService: 'Uninstall service',
      uninstallConfirmTitle: 'Uninstall this Runtime Host?',
      uninstallConfirmBody: 'This stops and removes the Maka-managed service and program, while preserving the State Root, projects, and task data. The Desktop profile is not removed.',
      uninstallConfirm: 'Uninstall service',
      uninstallRetained: (path: string) => `Service uninstalled. Data was retained at ${path}`,
      managementActionFailed: 'Unable to manage the Runtime Host service',
      managementReconnectFailed: 'Change applied, but Desktop could not reconnect',
      manageAccess: 'Manage access',
      accessTitle: 'Access',
      noAccessCredentials: 'No active access credentials',
      currentDesktop: 'This Desktop',
      accessKind: {
        owner: 'Client access',
        capabilityProvider: 'Capability provider',
      },
      accessPending: 'Pending confirmation',
      accessCreated: (date: string) => `Created ${date}`,
      rotateCredential: 'Rotate credential',
      rotateCredentialConfirmTitle: 'Rotate this Desktop credential?',
      rotateCredentialConfirmBody: 'Rotation reconnects this Runtime Host and may interrupt active work. Finish or pause active tasks before continuing.',
      rotateCredentialConfirm: 'Continue rotation',
      enableBeforeRotate: 'Enable this Runtime Host before rotating this Desktop credential.',
      startBeforeChangingAccess: 'Start the Runtime Host service before changing access.',
      revokeCredential: 'Revoke',
      revokeCredentialConfirm: (name: string) => `Revoke access for ${name}?`,
      revokeCredentialConfirmBody: 'Clients using this credential disconnect immediately, which may interrupt active work.',
      accessActionFailed: 'Unable to manage access',
      back: 'Back',
      remove: 'Remove',
      empty: 'No remote Hosts yet',
      loadFailed: 'Could not load Runtime Host profiles',
      selectFailed: 'Could not update the Runtime Host',
      saveFailed: 'Could not save the Runtime Host profile',
      removeFailed: 'Could not remove the Runtime Host profile',
      pairingRecoveryTitle: 'Pairing is unfinished',
      pairingRecoveryDescription: 'Retry from the affected Host menu, or discard the pairing to clean up the unfinished connection.',
      resolvePairingRecovery: 'Retry pairing',
      resolvePairingRecoveryFailed: 'Could not resolve pairing recovery',
      pairingPendingBadge: 'Pairing unfinished',
      discardPairing: 'Discard pairing',
      discardPairingConfirmTitle: 'Discard this pairing?',
      discardPairingConfirmBody: 'This removes the unfinished connection and its locally saved temporary credential. You can join again with a new invitation.',
      discardPairingFailed: 'Could not discard pairing',
      moreActions: (name: string) => `More actions for ${name}`,
    },
    section: 'Workspace',
    sectionHelp:
      'New tasks open in the default project; without one, they reuse the project you last used. You can switch any task to a different project next to the input box.',
    addProject: 'Add project',
    defaultBadge: 'Default',
    setDefault: 'Set as default',
    setDefaultTitle: 'Open new tasks in this project',
    setDefaultDisabledTitle: 'The folder is unavailable, so this cannot be the default',
    setDefaultFailed: 'Could not set the default project',
    rename: 'Rename',
    renameLabel: 'Project name',
    renameFailed: 'Could not rename the project',
    openFolder: 'Open project folder',
    openFolderFailed: 'Could not open this folder — it may have been moved or deleted',
    save: 'Save',
    cancel: 'Cancel',
    clearDefault: 'Clear default',
    remove: 'Remove from Maka',
    removeConfirmTitle: 'Remove this project from Maka?',
    removeConfirmBody:
      'This only removes it from Maka’s project list; the files on disk are untouched. Tasks under this project move to “Ungrouped” and are not deleted.',
    removeConfirm: 'Remove',
    removeCancel: 'Cancel',
    actionFailed: 'Action failed',
    unavailable: 'Folder unavailable',
    defaultUnavailable:
      'The default project is no longer available, so new tasks reuse the project you last used.',
    emptyTitle: 'No projects yet',
    emptyBody:
      'Add a project folder and new tasks can start in it, with the sidebar grouping tasks by project.',
    moreActions: (projectName: string) => `More actions for ${projectName}`,
  },
} satisfies UiCatalog<SettingsProjectsCopy>;

export function getSettingsProjectsCopy(locale: UiLocale): SettingsProjectsCopy {
  return SETTINGS_PROJECTS_COPY_BY_LOCALE[locale];
}
