import type {
  ThemePalette,
  ThemePreference,
  UiCatalog,
  UiLocale,
  UiLocalePreference,
} from '@maka/core';

type OptionCopy = { label: string; help: string };

export type SettingsPreferencesCopy = {
  personalization: {
    saveFailed: string;
    displayName: string;
    displayNameHelp: string;
    displayNamePlaceholder: string;
    interfaceLanguage: string;
    interfaceLanguageHelp: string;
    localeOptions: ReadonlyArray<readonly [UiLocalePreference, string]>;
    assistantTone: string;
    assistantToneHelp: string;
    assistantTonePlaceholder: string;
  };
  appearance: {
    saveFailed: string;
    theme: string;
    palette: string;
    themeOptions: Record<ThemePreference, OptionCopy>;
    paletteLabels: Record<ThemePalette, string>;
    paletteHelp: Record<ThemePalette, string>;
    paletteGroups: { editor: string; product: string };
    persistenceHelp: string;
    skins: {
      title: string;
      help: string;
      import: string;
      openFolder: string;
      activate: string;
      disable: string;
      active: string;
      empty: string;
      safeMode: string;
      actionFailed: string;
    };
  };
  general: {
    incognito: string;
    incognitoHelp: string;
    enableIncognito: string;
    incognitoFailed: string;
    notifications: string;
    notificationsHelp: string;
    notificationsFailed: string;
    updateFailed: string;
    defaultModel: string;
    defaultModelHelp: string;
    notSet: string;
    saveDefaultModelFailed: string;
    defaultPermission: string;
    defaultPermissionHelp: string;
    saveDefaultPermissionFailed: string;
    proxy: string;
    proxyHelp: string;
    enableProxy: string;
    saveNetworkFailed: string;
    proxyProtocol: string;
    serverAddress: string;
    proxyServerAddress: string;
    port: string;
    proxyPort: string;
    proxyAuth: string;
    proxyAuthHelp: string;
    enableProxyAuth: string;
    username: string;
    proxyUsername: string;
    password: string;
    proxyPassword: string;
    bypassList: string;
    bypassHelp: string;
    autoBypass(count: number): string;
    testing: string;
    testCurrent: string;
    proxyReachable: string;
    proxyTestFailed: string;
    proxyTestError: string;
  };
  about: {
    loadFailed: string;
    loading: string;
    unavailable: string;
    copied: string;
    pasteHint: string;
    copyFailed: string;
    clipboardUnavailable: string;
    devBuild: string;
    packagedBuild: string;
    subtitle: string;
    privacyLabel: string;
    privacyTitle: string;
    privacyPoints: readonly string[];
    runtime: string;
    runtimeDetail: string;
    platform: string;
    platformDetail: string;
    workspace: string;
    workspaceDetail: string;
    storage: string;
    storageDetail: string;
    local: string;
    copying: string;
    copyEnvironment: string;
    copyHelp: string;
  };
  password: {
    copyFailed: string;
    clipboardUnavailable: string;
    copying: string;
    copied: string;
    copy: string;
    hide: string;
    show: string;
  };
};

const SETTINGS_PREFERENCES_COPY_BY_LOCALE = {
  zh: {
    personalization: {
      saveFailed: '保存失败', displayName: '显示名称', displayNameHelp: 'Maka 在聊天里会以这个名字称呼你。留空就用默认的“你”。', displayNamePlaceholder: '例如：JK',
      interfaceLanguage: '界面语言', interfaceLanguageHelp: '选择 Maka 界面的显示语言。切换后立即生效，重启后保持。', localeOptions: [['auto', '跟随系统'], ['zh', '中文'], ['en', 'English']],
      assistantTone: '助手语气偏好', assistantToneHelp: '最多 500 字，只影响回答的语气和风格。权限确认与安全规则不受影响；改动会自动保存。', assistantTonePlaceholder: '例如：技术严谨、偏简洁、不要 emoji。',
    },
    appearance: {
      saveFailed: '保存外观设置失败', theme: '主题', palette: '调色板',
      themeOptions: { light: { label: '浅色', help: '始终使用浅色界面。' }, dark: { label: '深色', help: '始终使用深色界面。' }, auto: { label: '跟随系统', help: '匹配系统当前的浅色或深色偏好。' } },
      paletteLabels: { default: '默认', onedark: 'One Dark', 'catppuccin-mocha': 'Catppuccin Mocha', 'tokyo-night': 'Tokyo Night', nord: 'Nord', coral: '珊瑚', azure: '湖蓝', forest: '森林', dusk: '暮光', sand: '沙金', mono: '极简灰' },
      paletteHelp: { default: 'Maka 品牌蓝强调色', onedark: '编辑器经典深色', 'catppuccin-mocha': '紫调柔和深色', 'tokyo-night': '深蓝主题', nord: '北欧冷色', coral: '暖粉 / 珊瑚强调色', azure: '湖蓝强调色，干净冷静', forest: '深苔绿与暖蜂蜜强调色', dusk: '深紫罗兰与冷调画布', sand: '琥珀沙金与暖奶白', mono: '纯灰阶，无彩色干扰' },
      paletteGroups: { editor: '编辑器主题', product: '产品色调' }, persistenceHelp: '切换会立即生效，并保存在本地外观设置里供下次启动使用。',
      skins: {
        title: '界面皮肤', help: '导入 .maka-skin，可使用完整 CSS 和隔离世界 JavaScript 改造整个界面。皮肤能读取并修改可见页面，只安装你信任的包。',
        import: '导入皮肤', openFolder: '打开目录', activate: '启用', disable: '停用', active: '使用中', empty: '还没有安装皮肤。',
        safeMode: '安全模式已开启；所有皮肤暂时停用。移除 --disable-skins 后重启可恢复。', actionFailed: '皮肤操作失败',
      },
    },
    general: {
      incognito: '隐身模式', incognitoHelp: '开启后暂停本地记忆读写、联网搜索和计划提醒触发。', enableIncognito: '启用隐身模式', incognitoFailed: '隐身模式切换失败', notifications: '完成时发送系统通知', notificationsHelp: '窗口不在前台时，在回答完成或出错后发送桌面通知。', notificationsFailed: '通知设置切换失败', updateFailed: '设置未生效，请稍后重试。',
      defaultModel: '默认模型', defaultModelHelp: '新对话默认使用的模型。', notSet: '未设置', saveDefaultModelFailed: '保存默认模型失败', defaultPermission: '默认权限模式', defaultPermissionHelp: '新对话默认使用的权限模式；可在对话内随时切换。', saveDefaultPermissionFailed: '保存默认权限模式失败',
      proxy: '代理服务器', proxyHelp: '为 AI 模型请求配置网络代理', enableProxy: '启用代理服务器', saveNetworkFailed: '保存网络设置失败', proxyProtocol: '代理协议', serverAddress: '服务器地址', proxyServerAddress: '代理服务器地址', port: '端口', proxyPort: '代理端口', proxyAuth: '代理认证', proxyAuthHelp: '需要用户名和密码时开启。', enableProxyAuth: '启用代理认证', username: '用户名', proxyUsername: '代理用户名', password: '密码', proxyPassword: '代理密码', bypassList: '代理白名单', bypassHelp: '这些域名将绕过代理直连，多个用逗号分隔。', autoBypass: (count) => `已自动添加 ${count} 个域名。代理仅作用于 AI 模型请求。`, testing: '测试中…', testCurrent: '测试当前配置', proxyReachable: '代理可达', proxyTestFailed: '代理测试失败', proxyTestError: '代理测试出错',
    },
    about: {
      loadFailed: '载入关于信息失败', loading: '正在加载关于页', unavailable: '无法载入关于信息', copied: '已复制环境信息', pasteHint: '可直接粘贴到问题报告', copyFailed: '复制失败', clipboardUnavailable: '剪贴板不可用或被系统拒绝。', devBuild: '本地开发版', packagedBuild: '正式版', subtitle: '本地优先的 AI 助手 · 桌面端运行环境', privacyLabel: '隐私与安全', privacyTitle: '本地优先 · 隐私默认', privacyPoints: ['所有会话、设置、凭据和 Skill 指令文件都保留在本机工作区。', '模型密钥保存在本机凭据文件内；订阅账号令牌使用系统安全存储。', 'Maka 不发送使用遥测；只在你显式启用时与所选模型供应商通信。', '高风险工具操作需要在对话内明示授权。', '每个会话都会在本机保留消息、工具调用、权限决策与模式变更记录。'], runtime: '运行时', runtimeDetail: '界面层、桌面运行时和本地 Node 版本号。', platform: '平台', platformDetail: '操作系统、版本和 CPU 架构。', workspace: '工作区', workspaceDetail: '会话、设置和凭据全部留在本地这条路径下。', storage: '存储', storageDetail: '会话、设置、使用统计、凭据文件和订阅账号安全存储。', local: '本地', copying: '复制中…', copyEnvironment: '复制环境信息', copyHelp: '复制以上版本与平台信息以便定位问题；内容不包含工作区路径。',
    },
    password: { copyFailed: '复制失败', clipboardUnavailable: '剪贴板不可用或被系统拒绝。', copying: '复制中', copied: '已复制', copy: '复制', hide: '隐藏', show: '显示' },
  },
  en: {
    personalization: {
      saveFailed: 'Could not save', displayName: 'Display name', displayNameHelp: 'Maka uses this name when addressing you. Leave it blank to use “you”.', displayNamePlaceholder: 'For example: JK', interfaceLanguage: 'Interface language', interfaceLanguageHelp: 'Choose the language used by Maka. Changes apply immediately and persist after restart.', localeOptions: [['auto', 'Follow system'], ['zh', '中文'], ['en', 'English']], assistantTone: 'Assistant tone', assistantToneHelp: 'Up to 500 characters. This changes response style only; permission and safety rules still apply. Changes save automatically.', assistantTonePlaceholder: 'For example: technically rigorous, concise, and no emoji.',
    },
    appearance: {
      saveFailed: 'Could not save appearance settings', theme: 'Theme', palette: 'Color palette', themeOptions: { light: { label: 'Light', help: 'Always use the light interface.' }, dark: { label: 'Dark', help: 'Always use the dark interface.' }, auto: { label: 'Follow system', help: 'Match the current system appearance.' } }, paletteLabels: { default: 'Default', onedark: 'One Dark', 'catppuccin-mocha': 'Catppuccin Mocha', 'tokyo-night': 'Tokyo Night', nord: 'Nord', coral: 'Coral', azure: 'Azure', forest: 'Forest', dusk: 'Dusk', sand: 'Sand', mono: 'Monochrome' }, paletteHelp: { default: 'Maka brand-blue accent', onedark: 'Classic dark editor theme', 'catppuccin-mocha': 'Soft purple dark theme', 'tokyo-night': 'Deep-blue editor theme', nord: 'Cool Nordic colors', coral: 'Warm pink and coral accent', azure: 'Clean, calm blue accent', forest: 'Deep moss and warm honey', dusk: 'Deep violet on a cool canvas', sand: 'Amber sand and warm ivory', mono: 'Pure grayscale without color distraction' }, paletteGroups: { editor: 'Editor themes', product: 'Product colors' }, persistenceHelp: 'Changes apply immediately and are saved locally for the next launch.',
      skins: {
        title: 'Interface skins', help: 'Import a .maka-skin package with full CSS and isolated-world JavaScript. Skins can read and modify visible page content, so install only packages you trust.',
        import: 'Import skin', openFolder: 'Open folder', activate: 'Activate', disable: 'Disable', active: 'Active', empty: 'No skins are installed yet.',
        safeMode: 'Safe mode is active and all skins are disabled. Restart without --disable-skins to restore them.', actionFailed: 'Skin action failed',
      },
    },
    general: {
      incognito: 'Incognito mode', incognitoHelp: 'Pause local memory, web search, and scheduled reminder triggers.', enableIncognito: 'Enable incognito mode', incognitoFailed: 'Could not change incognito mode', notifications: 'Send a system notification when finished', notificationsHelp: 'Notify when a response finishes or fails while the window is in the background.', notificationsFailed: 'Could not change notification settings', updateFailed: 'The setting was not applied. Try again later.', defaultModel: 'Default model', defaultModelHelp: 'Model used by new conversations.', notSet: 'Not set', saveDefaultModelFailed: 'Could not save the default model', defaultPermission: 'Default permission mode', defaultPermissionHelp: 'Initial permission mode for new conversations; it can be changed at any time.', saveDefaultPermissionFailed: 'Could not save the default permission mode', proxy: 'Proxy server', proxyHelp: 'Configure a network proxy for AI model requests', enableProxy: 'Enable proxy server', saveNetworkFailed: 'Could not save network settings', proxyProtocol: 'Proxy protocol', serverAddress: 'Server address', proxyServerAddress: 'Proxy server address', port: 'Port', proxyPort: 'Proxy port', proxyAuth: 'Proxy authentication', proxyAuthHelp: 'Enable this when a username and password are required.', enableProxyAuth: 'Enable proxy authentication', username: 'Username', proxyUsername: 'Proxy username', password: 'Password', proxyPassword: 'Proxy password', bypassList: 'Proxy bypass list', bypassHelp: 'These domains connect directly. Separate multiple domains with commas.', autoBypass: (count) => `${count} ${count === 1 ? 'domain was' : 'domains were'} added automatically. The proxy applies to AI model requests only.`, testing: 'Testing…', testCurrent: 'Test current configuration', proxyReachable: 'Proxy is reachable', proxyTestFailed: 'Proxy test failed', proxyTestError: 'Could not test proxy',
    },
    about: {
      loadFailed: 'Could not load About information', loading: 'Loading About', unavailable: 'About information is unavailable', copied: 'Environment info copied', pasteHint: 'Paste it directly into an issue report', copyFailed: 'Copy failed', clipboardUnavailable: 'The clipboard is unavailable or access was denied.', devBuild: 'Local development build', packagedBuild: 'Release build', subtitle: 'A local-first AI assistant · Desktop runtime', privacyLabel: 'Privacy and security', privacyTitle: 'Local first · Private by default', privacyPoints: ['Conversations, settings, credentials, and Skill instructions stay in the local workspace.', 'Model keys stay in a local credential file; subscription tokens use secure system storage.', 'Maka sends no usage telemetry and contacts a model provider only when you enable it.', 'High-risk tool operations require explicit permission in the conversation.', 'Messages, tool calls, permission decisions, and mode changes are retained locally for each session.'], runtime: 'Runtime', runtimeDetail: 'Interface, desktop runtime, and local Node versions.', platform: 'Platform', platformDetail: 'Operating system, version, and CPU architecture.', workspace: 'Workspace', workspaceDetail: 'Conversations, settings, and credentials stay under this local path.', storage: 'Storage', storageDetail: 'Conversations, settings, usage statistics, credential files, and secure subscription storage.', local: 'Local', copying: 'Copying…', copyEnvironment: 'Copy environment info', copyHelp: 'Copy version and platform details to help diagnose an issue. The workspace path is excluded.',
    },
    password: { copyFailed: 'Copy failed', clipboardUnavailable: 'The clipboard is unavailable or access was denied.', copying: 'Copying', copied: 'Copied', copy: 'Copy', hide: 'Hide', show: 'Show' },
  },
} satisfies UiCatalog<SettingsPreferencesCopy>;

export function getSettingsPreferencesCopy(locale: UiLocale): SettingsPreferencesCopy {
  return SETTINGS_PREFERENCES_COPY_BY_LOCALE[locale];
}
