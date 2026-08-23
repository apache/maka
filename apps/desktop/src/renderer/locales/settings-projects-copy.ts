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
    configureManually: string;
    setupTitle: string;
    setupDescription: string;
    setupName: string;
    setupSshPort: string;
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
    defaultDisableHelp: string;
    unavailable: string;
    manage: string;
    managementTitle(name: string): string;
    serviceStatus: string;
    serviceState: Record<import('../../preload/bridge-contract.js').DesktopRuntimeHostManagementResult['service']['state'], string>;
    installedVersion: string;
    operatingSystem: string;
    processId: string;
    lastExitCode: string;
    stateRoot: string;
    directoryRoots: string;
    noDirectoryRoots: string;
    refresh: string;
    startService: string;
    restartService: string;
    repairService: string;
    showLogs: string;
    noLogs: string;
    uninstallService: string;
    uninstallConfirmTitle: string;
    uninstallConfirmBody: string;
    uninstallConfirm: string;
    uninstallRetained(path: string): string;
    managementActionFailed: string;
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
  zh: {
    runtimeHost: {
      title: 'Runtime Host',
      description: 'Local 与启用的远程 Host 会同时保持连接；任务仍由其所属 Host 处理。',
      selected: '默认 Host',
      selectedHelp: '新任务和未指定 Host 的设置使用默认 Host',
      remoteTitle: '远程 Host',
      remoteDescription: '通过 SSH 自动设置一台电脑，或手动连接已有 Runtime Host。',
      addComputer: '添加电脑',
      configureManually: '手动配置',
      setupTitle: '添加远程电脑',
      setupDescription: '通过 SSH 安装并连接 Runtime Host',
      setupName: '显示名称（可选）',
      setupSshPort: 'SSH 端口（可选）',
      setupConnect: '连接',
      setupCancel: '取消',
      setupRetry: '重试',
      setupDone: '完成',
      setupChooseProject: '选择项目',
      setupComplete: 'Runtime Host 已连接',
      setupPhase: {
        connecting_ssh: '正在连接 SSH…',
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
      installedVersion: '版本',
      operatingSystem: '系统',
      processId: '进程 ID',
      lastExitCode: '上次退出码',
      stateRoot: 'State Root',
      directoryRoots: '可用目录',
      noDirectoryRoots: '未配置额外目录',
      refresh: '刷新',
      startService: '启动',
      restartService: '重启',
      repairService: '修复',
      showLogs: '查看日志',
      noLogs: '没有服务日志',
      uninstallService: '卸载服务',
      uninstallConfirmTitle: '卸载远程 Runtime Host？',
      uninstallConfirmBody: '这会停止并移除 Maka 管理的服务与程序，但保留 State Root、项目和任务数据。当前 Desktop Profile 不会被删除。',
      uninstallConfirm: '卸载服务',
      uninstallRetained: (path: string) => `服务已卸载，数据保留在 ${path}`,
      managementActionFailed: '无法管理 Runtime Host 服务',
      remove: '移除',
      empty: '还没有远程 Host',
      loadFailed: '无法读取 Runtime Host profiles',
      selectFailed: '无法更新 Runtime Host',
      saveFailed: '无法保存 Runtime Host profile',
      removeFailed: '无法移除 Runtime Host profile',
      pairingRecoveryTitle: '有未完成的配对',
      pairingRecoveryDescription: '远程 Host 恢复连接后，可在此继续完成配对。',
      resolvePairingRecovery: '重试配对',
      resolvePairingRecoveryFailed: '无法处理配对恢复',
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
  en: {
    runtimeHost: {
      title: 'Runtime Host',
      description: 'Local and enabled remote Hosts stay connected together. Each task remains owned by its Host.',
      selected: 'Default Host',
      selectedHelp: 'New tasks and unscoped settings use the default Host',
      remoteTitle: 'Remote Hosts',
      remoteDescription:
        'Set up a computer over SSH, or connect an existing Runtime Host manually.',
      addComputer: 'Add computer',
      configureManually: 'Configure manually',
      setupTitle: 'Add remote computer',
      setupDescription: 'Install and connect Runtime Host over SSH',
      setupName: 'Display name (optional)',
      setupSshPort: 'SSH port (optional)',
      setupConnect: 'Connect',
      setupCancel: 'Cancel',
      setupRetry: 'Retry',
      setupDone: 'Done',
      setupChooseProject: 'Choose project',
      setupComplete: 'Runtime Host connected',
      setupPhase: {
        connecting_ssh: 'Connecting over SSH…',
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
      installedVersion: 'Version',
      operatingSystem: 'System',
      processId: 'Process ID',
      lastExitCode: 'Last exit code',
      stateRoot: 'State Root',
      directoryRoots: 'Available directories',
      noDirectoryRoots: 'No additional directories configured',
      refresh: 'Refresh',
      startService: 'Start',
      restartService: 'Restart',
      repairService: 'Repair',
      showLogs: 'View logs',
      noLogs: 'No service logs were found',
      uninstallService: 'Uninstall service',
      uninstallConfirmTitle: 'Uninstall the remote Runtime Host?',
      uninstallConfirmBody: 'This stops and removes the Maka-managed service and program, while preserving the State Root, projects, and task data. The Desktop profile is not removed.',
      uninstallConfirm: 'Uninstall service',
      uninstallRetained: (path: string) => `Service uninstalled. Data was retained at ${path}`,
      managementActionFailed: 'Unable to manage the Runtime Host service',
      remove: 'Remove',
      empty: 'No remote Hosts yet',
      loadFailed: 'Could not load Runtime Host profiles',
      selectFailed: 'Could not update the Runtime Host',
      saveFailed: 'Could not save the Runtime Host profile',
      removeFailed: 'Could not remove the Runtime Host profile',
      pairingRecoveryTitle: 'Pairing is unfinished',
      pairingRecoveryDescription: 'Retry when the remote Host is reachable to finish pairing.',
      resolvePairingRecovery: 'Retry pairing',
      resolvePairingRecoveryFailed: 'Could not resolve pairing recovery',
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
