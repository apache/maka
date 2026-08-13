import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

export type SettingsProjectsCopy = {
  runtimeHost: {
    title: string;
    description: string;
    selected: string;
    selectedHelp: string;
    remoteTitle: string;
    remoteDescription: string;
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
    saveAndConnect: string;
    active: string;
    connect: string;
    unavailable: string;
    remove: string;
    empty: string;
    loadFailed: string;
    selectFailed: string;
    saveFailed: string;
    selectionNotSaved: string;
    removeFailed: string;
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
      description: '选择运行会话、自动化和后台工作的 Host。Local 使用这台设备。',
      selected: 'Host',
      selectedHelp: '切换会立即生效；连接失败时继续使用当前 Host',
      remoteTitle: '远程 Host',
      remoteDescription: '先在远程机器准备 service、Project 和访问凭据，再通过 TLS 或 SSH tunnel 连接。凭据不会写入 profile 文件。',
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
      saveAndConnect: '保存并连接',
      active: '当前',
      connect: '连接',
      unavailable: '无法连接',
      remove: '移除',
      empty: '还没有远程 Host',
      loadFailed: '无法读取 Runtime Host profiles',
      selectFailed: '无法选择 Runtime Host',
      saveFailed: '无法保存 Runtime Host profile',
      selectionNotSaved: 'Runtime Host 已连接，但未保存为启动选择',
      removeFailed: '无法移除 Runtime Host profile',
      moreActions: (name: string) => `更多操作：${name}`,
    },
    section: '工作区',
    // Says all three layers of the rule in one sentence, because a help line
    // that only mentions the default would leave the user guessing what
    // happens before they set one.
    sectionHelp: '新对话默认打开此项目；未设置时沿用上次使用的项目。任何对话都能在输入框旁临时切换。',
    addProject: '添加项目',
    defaultBadge: '默认',
    setDefault: '设为默认',
    setDefaultTitle: '新对话默认打开这个项目',
    setDefaultDisabledTitle: '目录不可用，无法设为默认',
    setDefaultFailed: '设置默认项目失败',
    rename: '重命名',
    renameLabel: '项目名称',
    renameFailed: '重命名失败',
    openFolder: '在访达中打开',
    // Says which of the two things went wrong, because the fix differs: a
    // missing folder is the user's to restore, a refusal to open is not.
    openFolderFailed: '打不开这个目录，它可能已被移动或删除',
    save: '保存',
    cancel: '取消',
    clearDefault: '取消默认',
    remove: '从 Maka 移除',
    removeConfirmTitle: '从 Maka 移除这个项目？',
    // The one thing a user actually fears here, stated first and plainly.
    removeConfirmBody: '仅从 Maka 的项目列表移除，磁盘上的文件不受影响。该项目下已有的对话会移到"未归属"分组，不会被删除。',
    removeConfirm: '移除',
    removeCancel: '取消',
    actionFailed: '操作失败',
    unavailable: '目录不可用',
    defaultUnavailable: '原来的默认项目已不可用，新对话暂时沿用上次使用的项目。',
    emptyTitle: '还没有项目',
    emptyBody: '添加一个项目目录后，新对话就能默认从它打开，侧边栏也会按项目归类对话。',
    moreActions: (projectName: string) => `更多操作：${projectName}`,
  },
  en: {
    runtimeHost: {
      title: 'Runtime Host',
      description: 'Choose the Host that runs sessions, automations, and background work. Local uses this device.',
      selected: 'Host',
      selectedHelp: 'Switches immediately; if connection fails, Desktop keeps using the current Host',
      remoteTitle: 'Remote Hosts',
      remoteDescription:
        'Prepare the service, Project, and access credential on the remote machine, then connect through TLS or an SSH tunnel. Credentials are never written to the profile file.',
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
      saveAndConnect: 'Save and connect',
      active: 'Active',
      connect: 'Connect',
      unavailable: 'Unavailable',
      remove: 'Remove',
      empty: 'No remote Hosts yet',
      loadFailed: 'Could not load Runtime Host profiles',
      selectFailed: 'Could not select the Runtime Host',
      saveFailed: 'Could not save the Runtime Host profile',
      selectionNotSaved: 'Runtime Host connected, but the startup selection was not saved',
      removeFailed: 'Could not remove the Runtime Host profile',
      moreActions: (name: string) => `More actions for ${name}`,
    },
    section: 'Workspace',
    sectionHelp:
      'New conversations open in the default project; without one, they reuse the project you last used. Any conversation can switch next to the input box.',
    addProject: 'Add project',
    defaultBadge: 'Default',
    setDefault: 'Set as default',
    setDefaultTitle: 'Open new conversations in this project',
    setDefaultDisabledTitle: 'The folder is unavailable, so this cannot be the default',
    setDefaultFailed: 'Could not set the default project',
    rename: 'Rename',
    renameLabel: 'Project name',
    renameFailed: 'Could not rename the project',
    openFolder: 'Reveal in Finder',
    openFolderFailed: 'Could not open this folder — it may have been moved or deleted',
    save: 'Save',
    cancel: 'Cancel',
    clearDefault: 'Clear default',
    remove: 'Remove from Maka',
    removeConfirmTitle: 'Remove this project from Maka?',
    removeConfirmBody:
      'This only removes it from Maka’s project list; the files on disk are untouched. Conversations under this project move to “Ungrouped” and are not deleted.',
    removeConfirm: 'Remove',
    removeCancel: 'Cancel',
    actionFailed: 'Action failed',
    unavailable: 'Folder unavailable',
    defaultUnavailable:
      'The default project is no longer available, so new conversations reuse the project you last used.',
    emptyTitle: 'No projects yet',
    emptyBody:
      'Add a project folder and new conversations can start in it, with the sidebar grouping conversations by project.',
    moreActions: (projectName: string) => `More actions for ${projectName}`,
  },
} satisfies UiCatalog<SettingsProjectsCopy>;

export function getSettingsProjectsCopy(locale: UiLocale): SettingsProjectsCopy {
  return SETTINGS_PROJECTS_COPY_BY_LOCALE[locale];
}
