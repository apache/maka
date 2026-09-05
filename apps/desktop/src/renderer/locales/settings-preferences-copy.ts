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
import type { AppIcon, ThemePalette, ThemePreference } from '@maka/core/settings';

import type { UiCatalog, UiLocale, UiLocalePreference } from '@maka/core/ui-locale';

type OptionCopy = { label: string; help: string };

export type SettingsPreferencesCopy = {
  personalization: {
    saveFailed: string;
    displayName: string;
    displayNameHelp: string;
    displayNamePlaceholder: string;
    displayNameUnset: string;
    displayNameChange: string;
    displayNameSet: string;
    interfaceLanguage: string;
    interfaceLanguageHelp: string;
    localeOptions: ReadonlyArray<readonly [UiLocalePreference, string]>;
    assistantTone: string;
    assistantToneHelp: string;
    assistantTonePlaceholder: string;
  };
  /**
   * Group titles for the SettingsSection headers. They live in one block
   * rather than beside each control's own copy because they name the GROUP,
   * not a setting — keeping them together is what makes an inconsistent
   * grouping visible when it is edited.
   */
  sections: {
    identity: string;
    identityHelp: string;
    privacy: string;
    privacyHelp: string;
    chatDefaults: string;
    chatDefaultsHelp: string;
    shell: string;
    shellHelp: string;
    network: string;
    networkHelp: string;
    theme: string;
    themeHelp: string;
    palette: string;
    paletteHelp: string;
    appIcon: string;
    appIconHelp: string;
    fontSize: string;
    fontSizeHelp: string;
    pets: string;
    petsHelp: string;
  };
  appearance: {
    saveFailed: string;
    theme: string;
    palette: string;
    themeOptions: Record<ThemePreference, OptionCopy>;
    paletteLabels: Record<ThemePalette, string>;
    paletteHelp: Record<ThemePalette, string>;
    paletteGroups: { editor: string; product: string };
    appIconLabels: Record<AppIcon, string>;
    appIconHelp: Record<AppIcon, string>;
    appIconGroups: Record<
      | 'mascot'
      | 'blue'
      | 'contrast'
      | 'pencil'
      | 'mountain'
      | 'dark'
      | 'neon'
      | 'muted'
      | 'warm'
      | 'nature'
      | 'metal'
      | 'highContrast'
      | 'custom',
      string
    >;
    appIconSplitLabel: string;
    appIconSplitHelp: string;
    appIconTargets: Record<'light' | 'dark', string>;
    appIconCustom: string;
    appIconCustomHelp: string;
    appIconImport: string;
    appIconImporting: string;
    appIconImportHelp: string;
    appIconRemove: string;
    appIconImportError: string;
    appIconRemoveFailed: string;
    appIconSelectFailed: string;
    appIconImportFailed: Record<
      'too_large' | 'too_many_pixels' | 'unsupported_format' | 'unreadable' | 'too_small' | 'write_failed',
      string
    >;
    appIconUnavailable: string;
    fontSize: {
      uiLabel: string;
      uiHelp: string;
      terminalLabel: string;
      terminalHelp: string;
    };
  };
  pets: {
    import: string;
    importing: string;
    loading: string;
    status: string;
    activePet(name: string): string;
    disabled: string;
    disable: string;
    disabling: string;
    empty: string;
    emptyHelp: string;
    selected: string;
    select: string;
    selecting: string;
    remove: string;
    removing: string;
    removeTitle(name: string): string;
    removeDescription: string;
    confirmRemove: string;
    cancel: string;
    loadFailed: string;
    importFailed: string;
    selectFailed: string;
    removeFailed: string;
    importErrors: {
      invalid_directory: string;
      invalid_manifest: string;
      invalid_asset: string;
      already_installed: string;
      read_failed: string;
    };
    selectErrors: {
      invalid_id: string;
      not_found: string;
      read_failed: string;
      write_failed: string;
    };
    removeErrors: {
      invalid_id: string;
      remove_failed: string;
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
    workspaceInstructions: string;
    workspaceInstructionsHelp: string;
    workspaceInstructionsFailed: string;
    workHub: string;
    workHubHelp: string;
    workHubFailed: string;
    updateFailed: string;
    defaultModel: string;
    defaultModelHelp: string;
    notSet: string;
    saveDefaultModelFailed: string;
    defaultPermission: string;
    defaultPermissionHelp: string;
    defaultThinking: string;
    defaultThinkingHelp: string;
    followModelDefault: string;
    saveDefaultThinkingFailed: string;
    saveDefaultPermissionFailed: string;
    shellPreference: string;
    shellPreferenceHelp: string;
    shellAuto: string;
    shellGitBash: string;
    shellExecutable: string;
    shellExecutableHelp: string;
    saveShell: string;
    savingShell: string;
    shellSaved: string;
    saveShellFailed: string;
    shellExecutableRejected: string;
    proxy: string;
    proxyHelp: string;
    enableProxy: string;
    saveNetworkFailed: string;
    proxyProtocol: string;
    serverAddress: string;
    port: string;
    proxyAuth: string;
    proxyAuthHelp: string;
    enableProxyAuth: string;
    username: string;
    password: string;
    passwordSavedPlaceholder: string;
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
    nightlyBuild: string;
    buildLabel: string;
    /** One sentence saying what following this channel means for the user. */
    channelSummaries: Record<'dev' | 'nightly' | 'release', string>;
    supportTitle: string;
    reportIssueHelp: string;
    reportIssueOpen: string;
    copyAction: string;
    privacyLabel: string;
    privacyTitle: string;
    privacyPoints: readonly string[];
    copying: string;
    copyDiagnostics: string;
    copyHelp: string;
    keyboardShortcuts: string;
    keyboardShortcutsHelp: string;
    keyboardShortcutsOpen: string;
    reportIssueLabel: string;
    checkForUpdates: string;
    checkingForUpdates: string;
    updateIdle: string;
    updateNotAvailable: string;
    updateAvailable: (version: string) => string;
    updateDownloading: (version: string, percent: number) => string;
    updateVerifying: (version: string) => string;
    updateDownloaded: (version: string) => string;
    updateInstalling: (version: string) => string;
    updateCheckFailed: string;
    updateCheckFailedDetail: (message: string) => string;
  };
  password: {
    copyFailed: string;
    clipboardUnavailable: string;
    copying: string;
    copied: string;
    copy: string;
    hide: string;
    show: string;
    value: string;
  };
};

const SETTINGS_PREFERENCES_COPY_BY_LOCALE = {
  'zh-CN': {
    personalization: {
      saveFailed: '保存失败', displayName: '显示名称', displayNameHelp: 'Maka 在聊天里会以这个名字称呼你。留空就用默认的“你”。', displayNamePlaceholder: '例如：JK', displayNameUnset: '未设置，Maka 会称呼你“你”', displayNameChange: '更改', displayNameSet: '设置',
      interfaceLanguage: '界面语言', interfaceLanguageHelp: '选择 Maka 界面的显示语言。切换后立即生效，重启后保持。', localeOptions: [['auto', '跟随系统'], ['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['en', 'English']],
      assistantTone: '助手语气偏好', assistantToneHelp: '最多 500 字，只影响回答的语气和风格。权限确认与安全规则不受影响；改动会自动保存。', assistantTonePlaceholder: '例如：技术严谨、偏简洁、不要 emoji。',
    },
    sections: {
      identity: '身份', identityHelp: 'Maka 如何称呼你，以及界面语言和回答语气。',
      privacy: '隐私与通知', privacyHelp: '本地数据的读写范围，以及桌面通知时机。',
      chatDefaults: '任务默认', chatDefaultsHelp: '新任务的起始模型、权限模式与思考级别。',
      shell: '命令行环境', shellHelp: '选择 Runtime Host 执行 Bash 工具和终端命令时使用的 shell。',
      network: '网络', networkHelp: 'AI 模型请求走的网络通道。',
      theme: '主题', themeHelp: '界面跟随系统，还是固定浅色或深色。',
      palette: '调色板', paletteHelp: '强调色与画布色调；切换会立即生效并保存在本地。',
      appIcon: '应用图标', appIconHelp: 'Dock、任务栏和切换器里显示的 Maka 图标；切换会立即生效。',
      fontSize: '字号', fontSizeHelp: '界面与终端的文字大小；调整会立即生效并保存在本地。',
      pets: '自定义宠物', petsHelp: '管理你自己导入的 PetPack。Maka 不预装、也不默认启用任何宠物。',
    },
    appearance: {
      saveFailed: '保存外观设置失败', theme: '主题', palette: '调色板',
      themeOptions: { light: { label: '浅色', help: '始终使用浅色界面。' }, dark: { label: '深色', help: '始终使用深色界面。' }, auto: { label: '跟随系统', help: '匹配系统当前的浅色或深色偏好。' } },
      paletteLabels: { default: '默认', onedark: 'One Dark', 'catppuccin-mocha': 'Catppuccin Mocha', 'tokyo-night': 'Tokyo Night', nord: 'Nord', coral: '珊瑚', azure: '湖蓝', forest: '森林', dusk: '暮光', sand: '沙金', mono: '极简灰' },
      paletteHelp: { default: 'Maka 品牌蓝强调色', onedark: '编辑器经典深色', 'catppuccin-mocha': '紫调柔和深色', 'tokyo-night': '深蓝主题', nord: '北欧冷色', coral: '暖粉 / 珊瑚强调色', azure: '湖蓝强调色，干净冷静', forest: '深苔绿与暖蜂蜜强调色', dusk: '深紫罗兰与冷调画布', sand: '琥珀沙金与暖奶白', mono: '纯灰阶，无彩色干扰' },
      paletteGroups: { editor: '编辑器主题', product: '产品色调' },
      appIconLabels: { default: '经典', mono: '单色', 'sky': '原色天蓝', 'cyan': '青蓝', 'ice': '冰蓝渐变', 'pale-inverted': '淡底深标', 'ink': '墨黑', 'paper': '纸白', 'graphite': '石墨', 'pencil-kraft': '铅笔・牛皮纸', 'pencil-sky': '铅笔・天蓝', 'pencil-navy': '铅笔・深蓝', 'alpine': '晴空雪山', 'dusk': '黄昏', 'night': '夜山', 'midnight': '午夜蓝', 'carbon': 'OLED 纯黑', 'slate': '石板', 'obsidian': '曜石', 'neon-cyan': '荧光青', 'matrix': '磷绿', 'magenta': '品红', 'amber-crt': '琥珀 CRT', 'clay': '陶土', 'sage': '鼠尾草', 'dust': '灰粉', 'fog': '雾蓝', 'sunset': '日落', 'amber': '琥珀', 'terracotta': '赤陶', 'ocean': '深海', 'moss': '苔原', 'desert': '沙漠', 'glacier': '冰川', 'gold': '鎏金', 'chrome': '铬', 'mono-black': '单色・黑', 'mono-white': '单色・白', 'hazard': '黑黄', 'forest': '苍绿' },
      appIconHelp: { default: 'Maka 默认品牌图标', mono: '灰阶版本，Dock 里更安静', 'sky': '几何 M 标，品牌蓝', 'cyan': '偏青的蓝', 'ice': '由浅到深的蓝色渐变', 'pale-inverted': '淡蓝底配深蓝标', 'ink': '黑底白标，对比最强', 'paper': '白底黑标', 'graphite': '白底黑标，笔尖为灰', 'pencil-kraft': '铅笔意象，牛皮纸底', 'pencil-sky': '铅笔意象，天蓝底', 'pencil-navy': '铅笔意象，深蓝底', 'alpine': '雪顶山峰，晴空底', 'dusk': '雪顶山峰，黄昏底', 'night': '雪顶山峰，夜色底', 'midnight': '深蓝底配亮蓝标，深色 Dock 里仍有轮廓', 'carbon': '纯黑底，OLED 屏上只剩标本身', 'slate': '冷灰底配浅灰标', 'obsidian': '紫黑渐变底配淡紫标', 'neon-cyan': '近黑底配荧光青', 'matrix': '终端显示器的磷光绿', 'magenta': '深紫底配品红', 'amber-crt': '早期终端的琥珀色', 'clay': '低饱和的陶土色', 'sage': '低饱和的灰绿', 'dust': '低饱和的灰粉', 'fog': '低饱和的灰蓝', 'sunset': '橙到粉的斜向渐变', 'amber': '琥珀底配深褐标', 'terracotta': '砖红渐变', 'ocean': '深青绿渐变', 'moss': '深苔绿渐变', 'desert': '沙色渐变配深褐标', 'glacier': '极浅的冰蓝渐变', 'gold': '标本身带金色渐变', 'chrome': '标本身带银色渐变', 'mono-black': '纯白底黑标，可单色打印', 'mono-white': '纯黑底白标', 'hazard': '黑底黄标，这组里对比最高', 'forest': '雪顶山峰，苍绿底' },
      appIconGroups: {
        mascot: '拟人', blue: '蓝色系', contrast: '黑白', pencil: '铅笔', mountain: '高山',
        dark: '深色', neon: '霓虹', muted: '莫兰迪', warm: '暖色', nature: '自然', metal: '金属', highContrast: '高对比',
        custom: '自定义',
      },
      appIconSplitLabel: '浅色和深色用不同图标',
      appIconSplitHelp: '关闭时两种外观共用一个图标。',
      appIconTargets: { light: '浅色', dark: '深色' },
      appIconCustom: '导入的图标',
      appIconCustomHelp: '你自己导入的图片',
      appIconImport: '导入图标…',
      appIconImporting: '正在导入…',
      appIconImportHelp: '方形 PNG 最好；四周留约 10% 透明边，Dock 里才会和其它应用一样大。',
      appIconRemove: '删除',
      appIconImportError: '导入图标失败',
      appIconRemoveFailed: '删除图标失败',
      appIconSelectFailed: '切换图标失败',
      appIconImportFailed: {
        too_large: '文件太大，换一张小一点的图片',
        too_many_pixels: '图片尺寸太大，最多 4096×4096',
        unsupported_format: '只支持 PNG 和 JPEG',
        unreadable: '这个文件读不出图像',
        too_small: '图片太小，至少需要 128×128',
        write_failed: '无法保存导入的图标',
      },
      appIconUnavailable: '无法载入应用图标',
      fontSize: { uiLabel: 'UI 字号', uiHelp: '调整界面使用的基准字号', terminalLabel: '终端字号', terminalHelp: '调整终端里命令输出与代码使用的字号' },
    },
    pets: {
      import: '导入 PetPack', importing: '正在导入…', loading: '正在载入自定义宠物…',
      status: '桌面宠物', activePet: (name) => `当前使用：${name}`, disabled: '已关闭', disable: '关闭宠物', disabling: '正在关闭…',
      empty: '还没有导入宠物', emptyHelp: '选择一个包含 pet.json 和精灵图的本地文件夹。',
      selected: '正在使用', select: '使用', selecting: '正在切换…', remove: '删除', removing: '正在删除…',
      removeTitle: (name) => `删除“${name}”？`, removeDescription: '这会删除 Maka 本地保存的该宠物包，且无法撤销。原始文件夹不会受影响。', confirmRemove: '删除', cancel: '取消',
      loadFailed: '无法载入自定义宠物', importFailed: '导入宠物失败', selectFailed: '切换宠物失败', removeFailed: '删除宠物失败',
      importErrors: { invalid_directory: '所选文件夹无效。', invalid_manifest: 'pet.json 不符合 maka.pet/v1 格式。', invalid_asset: '精灵图缺失、无效或超出限制。', already_installed: '已经导入了相同 ID 的宠物。', read_failed: '无法读取所选文件夹。' },
      selectErrors: { invalid_id: '宠物 ID 无效。', not_found: '该宠物已不在本地宠物库中。', read_failed: '无法读取宠物库。', write_failed: '无法保存宠物选择。' },
      removeErrors: { invalid_id: '宠物 ID 无效。', remove_failed: '无法删除本地宠物包。' },
    },
    general: {
      incognito: '隐身模式', incognitoHelp: '开启后暂停本地记忆读写、联网搜索和定时任务触发。', enableIncognito: '启用隐身模式', incognitoFailed: '隐身模式切换失败', notifications: '完成时发送系统通知', notificationsHelp: '窗口不在前台时，在回答完成或出错后发送桌面通知。', notificationsFailed: '通知设置切换失败', workspaceInstructions: '遵循项目指令', workspaceInstructionsHelp: '自动读取每个项目中已有的 AGENTS.md、CLAUDE.md 或 GEMINI.md；文件仍由各自项目管理。', workspaceInstructionsFailed: '项目指令设置切换失败', workHub: '启用 WorkHub', workHubHelp: 'WorkHub 目前仍不可用。此开关仅供开发测试，开启后也不能保证正常使用。', workHubFailed: 'WorkHub 设置切换失败', updateFailed: '设置未生效，请稍后重试。',
      defaultModel: '默认模型', defaultModelHelp: '新任务默认使用的模型。', notSet: '未设置', saveDefaultModelFailed: '保存默认模型失败', defaultPermission: '默认权限模式', defaultPermissionHelp: '新任务默认使用的权限模式；可在任务内随时切换。', saveDefaultPermissionFailed: '保存默认权限模式失败', defaultThinking: '默认思考级别', defaultThinkingHelp: '新任务的思考级别；当前模型不支持所选级别时用模型默认。', followModelDefault: '跟随模型默认', saveDefaultThinkingFailed: '保存默认思考级别失败',
      shellPreference: 'Bash 工具 shell', shellPreferenceHelp: '自动模式保持 Windows 的 PowerShell 优先规则；Git Bash 是仅对当前 Runtime Host 生效的显式覆盖。', shellAuto: '自动（推荐）', shellGitBash: 'Git Bash', shellExecutable: 'Git Bash 可执行文件', shellExecutableHelp: '填写 Runtime Host 所在 Windows 机器上 bash.exe 的绝对路径。也支持该机器上的旧版 System32 WSL Bash；保存时会验证 GNU Bash。', saveShell: '保存 shell 设置', savingShell: '正在保存…', shellSaved: '已保存', saveShellFailed: '保存 shell 设置失败', shellExecutableRejected: '当前 Runtime Host 无法把该路径作为 GNU Bash 运行。请检查 Host 是否为 Windows、路径是否存在，并确认文件名为 bash.exe。',
      proxy: '代理服务器', proxyHelp: '为 AI 模型请求配置网络代理', enableProxy: '启用代理服务器', saveNetworkFailed: '保存网络设置失败', proxyProtocol: '代理协议', serverAddress: '服务器地址', port: '端口', proxyAuth: '代理认证', proxyAuthHelp: '需要用户名和密码时开启。', enableProxyAuth: '启用代理认证', username: '用户名', password: '密码', bypassList: '代理白名单', bypassHelp: '这些域名将绕过代理直连，多个用逗号分隔。', autoBypass: (count) => `已自动添加 ${count} 个域名。代理仅作用于 AI 模型请求。`, testing: '测试中…', testCurrent: '测试当前配置', proxyReachable: '代理可达', proxyTestFailed: '代理测试失败', proxyTestError: '代理测试出错',
      passwordSavedPlaceholder: '密码已保存；输入新密码以替换',
    },
    about: {
      loadFailed: '载入关于信息失败', loading: '正在加载关于页', unavailable: '无法载入关于信息', copied: '已复制诊断信息', pasteHint: '检查内容后，可直接粘贴到问题报告', copyFailed: '复制失败', clipboardUnavailable: '剪贴板不可用或被系统拒绝。', devBuild: '本地开发版', nightlyBuild: 'Nightly', buildLabel: '构建',
      channelSummaries: {
        dev: '本地开发构建，不检查更新。',
        nightly: '每日构建的预发布版，自动更新到最新 nightly，会覆盖正式版安装。',
        release: '正式发布版，自动接收稳定更新。',
      },
      supportTitle: '支持',
      copying: '复制中…', copyDiagnostics: '复制诊断信息', copyAction: '复制', copyHelp: '复制版本、平台、隐藏主目录后的工作区路径与近期脱敏日志；仅写入剪贴板，不会自动上传。',
      reportIssueLabel: '报告问题', reportIssueHelp: '带上诊断信息去 GitHub Issues，回复更快。', reportIssueOpen: '打开',
      keyboardShortcuts: '键盘快捷键', keyboardShortcutsHelp: 'Maka 支持的全部快捷键一览。', keyboardShortcutsOpen: '查看',
      privacyLabel: '隐私承诺', privacyTitle: '本地优先 · 隐私默认', privacyPoints: ['任务、设置、凭据和 Skill 指令文件都留在本机；模型密钥保存在本机凭据文件内，订阅令牌使用系统安全存储。', 'Maka 不发送使用遥测；只在你显式启用时与所选模型供应商通信。', '高风险工具操作需要在任务内明示授权；每个任务都会在本机保留消息、工具调用、权限决策与模式变更记录。'],
      checkForUpdates: '检查更新',
      checkingForUpdates: '检查中…',
      updateIdle: '尚未检查更新。',
      updateNotAvailable: '已是最新版本。',
      updateAvailable: (version) => `发现新版本 v${version}，正在准备下载…`,
      updateDownloading: (version, percent) => `正在下载 v${version}（${percent}%）…`,
      updateVerifying: (version) => `正在验证 v${version} 的发布来源…`,
      updateDownloaded: (version) => `v${version} 已下载，可在侧栏选择重启安装。`,
      updateInstalling: (version) => `正在安装 v${version}…`,
      updateCheckFailed: '检查更新失败',
      updateCheckFailedDetail: (message) => message,
    },
    password: { copyFailed: '复制失败', clipboardUnavailable: '剪贴板不可用或被系统拒绝。', copying: '复制中', copied: '已复制', copy: '复制', hide: '隐藏', show: '显示', value: '凭据值' },
  },
  'zh-TW': {
    personalization: {
      saveFailed: '儲存失敗', displayName: '顯示名稱', displayNameHelp: 'Maka 在聊天裡會以這個名字稱呼你。留空就用預設的“你”。', displayNamePlaceholder: '例如：JK', displayNameUnset: '未設定，Maka 會稱呼你“你”', displayNameChange: '更改', displayNameSet: '設定',
      interfaceLanguage: '介面語言', interfaceLanguageHelp: '選擇 Maka 介面的顯示語言。切換後立即生效，重新啟動後仍會保留。', localeOptions: [['auto', '自動（跟隨系統）'], ['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['en', 'English']],
      assistantTone: '助手語氣偏好', assistantToneHelp: '最多 500 字，只影響回答的語氣和風格。權限確認與安全規則不受影響；改動會自動儲存。', assistantTonePlaceholder: '例如：技術嚴謹、偏簡潔、不要 emoji。',
    },
    sections: {
      identity: '身份', identityHelp: 'Maka 如何稱呼你，以及介面語言和回答語氣。',
      privacy: '隱私與通知', privacyHelp: '本地資料的讀寫範圍，以及桌面通知時機。',
      chatDefaults: '任務預設', chatDefaultsHelp: '新任務的起始模型、權限模式與思考級別。',
      shell: '命令列環境', shellHelp: '選擇 Runtime Host 執行 Bash 工具和終端命令時使用的 shell。',
      network: '網路', networkHelp: 'AI 模型請求走的網路通道。',
      theme: '主題', themeHelp: '介面跟隨系統，還是固定淺色或深色。',
      palette: '調色盤', paletteHelp: '強調色與畫布色調；切換會立即生效並儲存在本地。',
      appIcon: '應用圖示', appIconHelp: 'Dock、工作列和切換器裡顯示的 Maka 圖示；切換會立即生效。',
      fontSize: '字型大小', fontSizeHelp: '介面與終端機的文字大小；調整會立即生效並儲存在本機。',
      pets: '自訂寵物', petsHelp: '管理你自己匯入的 PetPack。Maka 不預裝、也不預設啟用任何寵物。',
    },
    appearance: {
      saveFailed: '儲存外觀設定失敗', theme: '主題', palette: '調色盤',
      themeOptions: { light: { label: '淺色', help: '始終使用淺色介面。' }, dark: { label: '深色', help: '始終使用深色介面。' }, auto: { label: '跟隨系統', help: '符合系統目前的淺色或深色偏好。' } },
      paletteLabels: { default: '預設', onedark: 'One Dark', 'catppuccin-mocha': 'Catppuccin Mocha', 'tokyo-night': 'Tokyo Night', nord: 'Nord', coral: '珊瑚', azure: '湖藍', forest: '森林', dusk: '暮光', sand: '沙金', mono: '極簡灰' },
      paletteHelp: { default: 'Maka 品牌藍強調色', onedark: '編輯器經典深色', 'catppuccin-mocha': '紫調柔和深色', 'tokyo-night': '深藍主題', nord: '北歐冷色', coral: '暖粉 / 珊瑚強調色', azure: '湖藍強調色，乾淨冷靜', forest: '深苔綠與暖蜂蜜強調色', dusk: '深紫羅蘭與冷調畫布', sand: '琥珀沙金與暖奶白', mono: '純灰階，無彩色干擾' },
      paletteGroups: { editor: '編輯器主題', product: '產品色調' },
      appIconLabels: { default: '經典', mono: '單色', 'sky': '原色天藍', 'cyan': '青藍', 'ice': '冰藍漸變', 'pale-inverted': '淡底深標', 'ink': '墨黑', 'paper': '紙白', 'graphite': '石墨', 'pencil-kraft': '鉛筆・牛皮紙', 'pencil-sky': '鉛筆・天藍', 'pencil-navy': '鉛筆・深藍', 'alpine': '晴空雪山', 'dusk': '黃昏', 'night': '夜山', 'midnight': '午夜藍', 'carbon': 'OLED 純黑', 'slate': '石板灰', 'obsidian': '黑曜石', 'neon-cyan': '霓虹青', 'matrix': '磷光綠', 'magenta': '洋紅', 'amber-crt': '琥珀 CRT', 'clay': '陶土', 'sage': '鼠尾草', 'dust': '灰粉', 'fog': '霧藍', 'sunset': '日落', 'amber': '琥珀', 'terracotta': '赤陶', 'ocean': '深海', 'moss': '苔原', 'desert': '沙漠', 'glacier': '冰河', 'gold': '鎏金', 'chrome': '鉻', 'mono-black': '單色・黑', 'mono-white': '單色・白', 'hazard': '黑黃', 'forest': '蒼綠' },
      appIconHelp: { default: 'Maka 預設品牌圖示', mono: '灰階版本，Dock 裡更安靜', 'sky': '幾何 M 標，品牌藍', 'cyan': '偏青的藍', 'ice': '由淺到深的藍色漸變', 'pale-inverted': '淡藍底配深藍標', 'ink': '黑底白標，對比最強', 'paper': '白底黑標', 'graphite': '白底黑標，筆尖為灰', 'pencil-kraft': '鉛筆意象，牛皮紙底', 'pencil-sky': '鉛筆意象，天藍底', 'pencil-navy': '鉛筆意象，深藍底', 'alpine': '雪頂山峰，晴空底', 'dusk': '雪頂山峰，黃昏底', 'night': '雪頂山峰，夜色底', 'midnight': '深藍底搭配亮藍標誌，在深色 Dock 上仍保有清楚輪廓', 'carbon': '純黑背景，OLED 螢幕只顯示標誌', 'slate': '冷色石板灰底搭配淺灰標誌', 'obsidian': '紫黑漸層底搭配淡紫標誌', 'neon-cyan': '近黑底搭配霓虹青', 'matrix': '終端機螢幕的磷光綠', 'magenta': '深紫底搭配洋紅', 'amber-crt': '早期終端機的琥珀色', 'clay': '低飽和陶土色', 'sage': '低飽和灰綠色', 'dust': '低飽和灰粉色', 'fog': '低飽和灰藍色', 'sunset': '橘色到粉色的斜向漸層', 'amber': '琥珀底搭配深褐標誌', 'terracotta': '磚紅漸層', 'ocean': '深青綠漸層', 'moss': '深苔綠漸層', 'desert': '沙色漸層搭配深褐標誌', 'glacier': '極淺的冰河藍漸層', 'gold': '標誌帶有金色漸層', 'chrome': '標誌帶有銀色漸層', 'mono-black': '純白底黑色標誌，可單色列印', 'mono-white': '純黑底白色標誌', 'hazard': '黑底黃色標誌，是本組對比最高的款式', 'forest': '綠色背景上的雪頂山峰' },
      appIconGroups: {
        mascot: '擬人', blue: '藍色系', contrast: '黑白', pencil: '鉛筆', mountain: '高山',
        dark: '深色', neon: '霓虹', muted: '柔和', warm: '暖色', nature: '自然', metal: '金屬', highContrast: '高對比',
        custom: '自訂',
      },
      appIconSplitLabel: '淺色與深色模式使用不同圖示',
      appIconSplitHelp: '關閉時，兩種外觀會共用同一個圖示。',
      appIconTargets: { light: '淺色', dark: '深色' },
      appIconCustom: '匯入的圖示',
      appIconCustomHelp: '你自己匯入的圖片',
      appIconImport: '匯入圖示…',
      appIconImporting: '正在匯入…',
      appIconImportHelp: '方形 PNG 最好；四周留約 10% 透明邊，Dock 裡才會和其它應用一樣大。',
      appIconRemove: '刪除',
      appIconImportError: '匯入圖示失敗',
      appIconRemoveFailed: '刪除圖示失敗',
      appIconSelectFailed: '切換圖示失敗',
      appIconImportFailed: {
        too_large: '檔案太大，換一張小一點的圖片',
        too_many_pixels: '圖片尺寸太大，最多 4096×4096',
        unsupported_format: '只支援 PNG 和 JPEG',
        unreadable: '這個檔案讀不出影像',
        too_small: '圖片太小，至少需要 128×128',
        write_failed: '無法儲存匯入的圖示',
      },
      appIconUnavailable: '無法載入應用圖示',
      fontSize: { uiLabel: 'UI 字型大小', uiHelp: '調整介面使用的基準字型大小', terminalLabel: '終端機字型大小', terminalHelp: '調整終端機命令輸出與程式碼使用的字型大小' },
    },
    pets: {
      import: '匯入 PetPack', importing: '正在匯入…', loading: '正在載入自訂寵物…',
      status: '桌面寵物', activePet: (name) => `目前使用：${name}`, disabled: '已關閉', disable: '關閉寵物', disabling: '正在關閉…',
      empty: '還沒有匯入寵物', emptyHelp: '選擇一個包含 pet.json 和精靈圖的本地資料夾。',
      selected: '正在使用', select: '使用', selecting: '正在切換…', remove: '刪除', removing: '正在刪除…',
      removeTitle: (name) => `刪除“${name}”？`, removeDescription: '這會刪除 Maka 本地儲存的該寵物包，且無法撤銷。原始資料夾不會受影響。', confirmRemove: '刪除', cancel: '取消',
      loadFailed: '無法載入自訂寵物', importFailed: '匯入寵物失敗', selectFailed: '切換寵物失敗', removeFailed: '刪除寵物失敗',
      importErrors: { invalid_directory: '所選資料夾無效。', invalid_manifest: 'pet.json 不符合 maka.pet/v1 格式。', invalid_asset: '精靈圖缺失、無效或超出限制。', already_installed: '已經匯入了相同 ID 的寵物。', read_failed: '無法讀取所選資料夾。' },
      selectErrors: { invalid_id: '寵物 ID 無效。', not_found: '該寵物已不在本地寵物庫中。', read_failed: '無法讀取寵物庫。', write_failed: '無法儲存寵物選擇。' },
      removeErrors: { invalid_id: '寵物 ID 無效。', remove_failed: '無法刪除本機寵物包。' },
    },
    general: {
      incognito: '隱身模式', incognitoHelp: '開啟後暫停本地記憶讀寫、聯網搜尋和定時任務觸發。', enableIncognito: '啟用隱身模式', incognitoFailed: '隱身模式切換失敗', notifications: '完成時傳送系統通知', notificationsHelp: '視窗不在前臺時，在回答完成或出錯後傳送桌面通知。', notificationsFailed: '通知設定切換失敗', workspaceInstructions: '遵循專案指令', workspaceInstructionsHelp: '自動讀取每個專案中已有的 AGENTS.md、CLAUDE.md 或 GEMINI.md；檔案仍由各自專案管理。', workspaceInstructionsFailed: '專案指令設定切換失敗', workHub: '啟用 WorkHub', workHubHelp: '在一個入口檢視已有工作，並將新輸入保守地送往普通任務。', workHubFailed: 'WorkHub 設定切換失敗', updateFailed: '設定未生效，請稍後重試。',
      defaultModel: '預設模型', defaultModelHelp: '新任務預設使用的模型。', notSet: '未設定', saveDefaultModelFailed: '儲存預設模型失敗', defaultPermission: '預設權限模式', defaultPermissionHelp: '新任務預設使用的權限模式；可在任務內隨時切換。', saveDefaultPermissionFailed: '儲存預設權限模式失敗', defaultThinking: '預設思考級別', defaultThinkingHelp: '新任務的思考級別；目前模型不支援所選級別時用模型預設。', followModelDefault: '跟隨模型預設', saveDefaultThinkingFailed: '儲存預設思考級別失敗',
      shellPreference: 'Bash 工具 shell', shellPreferenceHelp: '自動模式保持 Windows 的 PowerShell 優先規則；Git Bash 是僅對目前 Runtime Host 生效的顯式覆蓋。', shellAuto: '自動（推薦）', shellGitBash: 'Git Bash', shellExecutable: 'Git Bash 執行檔', shellExecutableHelp: '填寫 Runtime Host 所在 Windows 機器上 bash.exe 的絕對路徑。也支援該機器上的舊版 System32 WSL Bash；儲存時會驗證 GNU Bash。', saveShell: '儲存 shell 設定', savingShell: '正在儲存…', shellSaved: '已儲存', saveShellFailed: '儲存 shell 設定失敗', shellExecutableRejected: '目前 Runtime Host 無法把該路徑作為 GNU Bash 執行。請檢查 Host 是否為 Windows、路徑是否存在，並確認檔名為 bash.exe。',
      proxy: '代理伺服器', proxyHelp: '為 AI 模型請求設定網路代理', enableProxy: '啟用代理伺服器', saveNetworkFailed: '儲存網路設定失敗', proxyProtocol: '代理協議', serverAddress: '伺服器地址', port: '埠', proxyAuth: '代理認證', proxyAuthHelp: '需要使用者名稱和密碼時開啟。', enableProxyAuth: '啟用代理認證', username: '使用者名稱', password: '密碼', bypassList: '代理白名單', bypassHelp: '這些域名將繞過代理直連，多個用逗號分隔。', autoBypass: (count) => `已自動新增 ${count} 個域名。代理僅作用於 AI 模型請求。`, testing: '測試中…', testCurrent: '測試目前設定', proxyReachable: '代理可達', proxyTestFailed: '代理測試失敗', proxyTestError: '代理測試出錯',
      passwordSavedPlaceholder: '密碼已儲存；輸入新密碼以替換',
    },
    about: {
      loadFailed: '載入關於資訊失敗', loading: '正在載入關於頁', unavailable: '無法載入關於資訊', copied: '已複製診斷資訊', pasteHint: '檢查內容後，可直接貼上到問題報告', copyFailed: '複製失敗', clipboardUnavailable: '剪貼簿不可用或被系統拒絕。', devBuild: '本地開發版', nightlyBuild: 'Nightly', buildLabel: '建構', supportTitle: '支援', copyAction: '複製', reportIssueHelp: '帶上診斷資訊去 GitHub Issues，回覆更快。', reportIssueOpen: '開啟', channelSummaries: { dev: '本地開發建構，不檢查更新。', nightly: '每日建構的預發佈版，自動更新到最新 nightly，會覆蓋正式版安裝。', release: '正式發佈版，自動接收穩定更新。' }, privacyLabel: '隱私與安全', privacyTitle: '本地優先 · 隱私預設', privacyPoints: ['所有任務、設定、憑據和 Skill 指令檔案都保留在本機工作區。', '模型金鑰儲存在本機憑據檔案內；訂閱帳號權杖使用系統安全儲存。', 'Maka 不傳送使用遙測；只在你顯式啟用時與所選模型供應商通訊。', '高風險工具操作需要在任務內明示授權。', '每個任務都會在本機保留訊息、工具呼叫、權限決策與模式變更記錄。'], copying: '複製中…', copyDiagnostics: '複製診斷資訊', copyHelp: '複製版本、平臺、隱藏主目錄後的工作區路徑，以及近期脫敏的 Desktop 與 Runtime Host 記錄；僅寫入剪貼簿，不會自動上傳。', keyboardShortcuts: '鍵盤快捷鍵', keyboardShortcutsHelp: 'Maka 支援的全部快捷鍵一覽。', keyboardShortcutsOpen: '檢視', reportIssueLabel: '報告問題',

      checkForUpdates: '檢查更新',
      checkingForUpdates: '檢查中…',


      updateIdle: '尚未檢查更新。',
      updateNotAvailable: '已是最新版本。',
      updateAvailable: (version) => `發現新版本 v${version}，正在準備下載…`,
      updateDownloading: (version, percent) => `正在下載 v${version}（${percent}%）…`,
      updateVerifying: (version) => `正在驗證 v${version} 的發佈來源…`,
      updateDownloaded: (version) => `v${version} 已下載，可在側欄選擇重啟安裝。`,
      updateInstalling: (version) => `正在安裝 v${version}…`,
      updateCheckFailed: '檢查更新失敗',
      updateCheckFailedDetail: (message) => message,
    },
    password: { copyFailed: '複製失敗', clipboardUnavailable: '剪貼簿不可用或被系統拒絕。', copying: '複製中', copied: '已複製', copy: '複製', hide: '隱藏', show: '顯示', value: '憑據值' },
  },
  en: {
    personalization: {
      saveFailed: 'Could not save', displayName: 'Display name', displayNameHelp: 'Maka uses this name when addressing you. Leave it blank to use “you”.', displayNamePlaceholder: 'For example: JK', displayNameUnset: 'Not set — Maka will say “you”', displayNameChange: 'Change', displayNameSet: 'Set', interfaceLanguage: 'Interface language', interfaceLanguageHelp: 'Choose the language used by Maka. Changes apply immediately and persist after restart.', localeOptions: [['auto', 'Follow system'], ['zh-CN', 'Simplified Chinese'], ['zh-TW', 'Traditional Chinese'], ['en', 'English']], assistantTone: 'Assistant tone', assistantToneHelp: 'Up to 500 characters. This changes response style only; permission and safety rules still apply. Changes save automatically.', assistantTonePlaceholder: 'For example: technically rigorous, concise, and no emoji.',
    },
    sections: {
      identity: 'Identity', identityHelp: 'How Maka addresses you, plus interface language and response tone.',
      privacy: 'Privacy and notifications', privacyHelp: 'What Maka may read and write locally, and when it notifies you.',
      chatDefaults: 'Task defaults', chatDefaultsHelp: 'The model, permission mode, and thinking level a new task starts on.',
      shell: 'Command environment', shellHelp: 'Choose the shell the Runtime Host uses for Bash tools and terminal commands.',
      network: 'Network', networkHelp: 'The network path AI model requests take.',
      theme: 'Theme', themeHelp: 'Follow the system appearance, or stay on light or dark.',
      palette: 'Color palette', paletteHelp: 'Accent and canvas colors. Changes apply immediately and are saved locally.',
      appIcon: 'App icon', appIconHelp: 'The Maka icon shown in the dock, taskbar, and app switcher. Changes apply immediately.',
      fontSize: 'Font size', fontSizeHelp: 'Text size across the interface and terminal. Changes apply immediately and are saved locally.',
      pets: 'Custom pets', petsHelp: 'Manage PetPacks you import yourself. Maka does not bundle or enable any pet by default.',
    },
    appearance: {
      saveFailed: 'Could not save appearance settings', theme: 'Theme', palette: 'Color palette', themeOptions: { light: { label: 'Light', help: 'Always use the light interface.' }, dark: { label: 'Dark', help: 'Always use the dark interface.' }, auto: { label: 'Follow system', help: 'Match the current system appearance.' } }, paletteLabels: { default: 'Default', onedark: 'One Dark', 'catppuccin-mocha': 'Catppuccin Mocha', 'tokyo-night': 'Tokyo Night', nord: 'Nord', coral: 'Coral', azure: 'Azure', forest: 'Forest', dusk: 'Dusk', sand: 'Sand', mono: 'Monochrome' }, paletteHelp: { default: 'Maka brand-blue accent', onedark: 'Classic dark editor theme', 'catppuccin-mocha': 'Soft purple dark theme', 'tokyo-night': 'Deep-blue editor theme', nord: 'Cool Nordic colors', coral: 'Warm pink and coral accent', azure: 'Clean, calm blue accent', forest: 'Deep moss and warm honey', dusk: 'Deep violet on a cool canvas', sand: 'Amber sand and warm ivory', mono: 'Pure grayscale without color distraction' }, paletteGroups: { editor: 'Editor themes', product: 'Product colors' }, appIconLabels: { default: 'Classic', mono: 'Monochrome', 'sky': 'Sky', 'cyan': 'Cyan', 'ice': 'Ice', 'pale-inverted': 'Inverted', 'ink': 'Ink', 'paper': 'Paper', 'graphite': 'Graphite', 'pencil-kraft': 'Pencil, kraft', 'pencil-sky': 'Pencil, sky', 'pencil-navy': 'Pencil, navy', 'alpine': 'Alpine', 'dusk': 'Dusk', 'night': 'Night', 'midnight': 'Midnight', 'carbon': 'Carbon', 'slate': 'Slate', 'obsidian': 'Obsidian', 'neon-cyan': 'Neon cyan', 'matrix': 'Phosphor', 'magenta': 'Magenta', 'amber-crt': 'Amber CRT', 'clay': 'Clay', 'sage': 'Sage', 'dust': 'Dust', 'fog': 'Fog', 'sunset': 'Sunset', 'amber': 'Amber', 'terracotta': 'Terracotta', 'ocean': 'Ocean', 'moss': 'Moss', 'desert': 'Desert', 'glacier': 'Glacier', 'gold': 'Gold', 'chrome': 'Chrome', 'mono-black': 'Mono black', 'mono-white': 'Mono white', 'hazard': 'Hazard', 'forest': 'Forest' }, appIconHelp: { default: 'The default Maka mark', mono: 'Grayscale, for a quieter dock', 'sky': 'The geometric M mark in brand blue', 'cyan': 'Blue leaning to cyan', 'ice': 'A pale-to-deep blue gradient', 'pale-inverted': 'A deep blue mark on a pale field', 'ink': 'White on black, the highest contrast', 'paper': 'Black on white', 'graphite': 'Black on white with a grey tip', 'pencil-kraft': 'The pencil reading, on kraft paper', 'pencil-sky': 'The pencil reading, on sky blue', 'pencil-navy': 'The pencil reading, on deep navy', 'alpine': 'A snow-capped peak under clear sky', 'dusk': 'A snow-capped peak at dusk', 'night': 'A snow-capped peak at night', 'midnight': 'A bright mark on deep navy; keeps its edge on a dark dock', 'carbon': 'True black, so an OLED panel shows nothing but the mark', 'slate': 'Pale grey on cool slate', 'obsidian': 'Lilac on a violet-black gradient', 'neon-cyan': 'Electric cyan on near-black', 'matrix': 'The green of a phosphor terminal', 'magenta': 'Hot pink on deep violet', 'amber-crt': 'The amber of an early terminal', 'clay': 'Muted terracotta', 'sage': 'Muted grey-green', 'dust': 'Muted dusty rose', 'fog': 'Muted blue-grey', 'sunset': 'An orange-to-pink diagonal', 'amber': 'A dark mark on amber', 'terracotta': 'A brick-red gradient', 'ocean': 'A deep teal gradient', 'moss': 'A deep moss gradient', 'desert': 'A dark mark on desert sand', 'glacier': 'A pale glacial blue', 'gold': 'The mark itself carries a gold gradient', 'chrome': 'The mark itself carries a silver gradient', 'mono-black': 'Black on pure white; prints in one colour', 'mono-white': 'White on pure black', 'hazard': 'Yellow on black, the highest contrast in the set', 'forest': 'A snow-capped peak in green' }, appIconGroups: { mascot: 'Mascot', blue: 'Blues', contrast: 'Black & white', pencil: 'Pencil', mountain: 'Mountain', dark: 'Dark', neon: 'Neon', muted: 'Muted', warm: 'Warm', nature: 'Nature', metal: 'Metal', highContrast: 'High contrast', custom: 'Imported' }, appIconSplitLabel: 'Use a different icon in dark mode', appIconSplitHelp: 'When off, one icon is used in both appearances.', appIconTargets: { light: 'Light', dark: 'Dark' }, appIconCustom: 'Imported icon', appIconCustomHelp: 'An image you imported', appIconImport: 'Import icon…', appIconImporting: 'Importing…', appIconImportHelp: 'A square PNG works best. Leave about 10% transparent margin so it sits the same size as other apps in the dock.', appIconRemove: 'Remove', appIconImportError: 'Could not import the icon', appIconRemoveFailed: 'Could not remove the icon', appIconSelectFailed: 'Could not switch the icon', appIconImportFailed: { too_large: 'That file is too large; pick a smaller image', too_many_pixels: 'That image is too large; 4096×4096 is the maximum', unsupported_format: 'Only PNG and JPEG are supported', unreadable: 'No image could be read from that file', too_small: 'That image is too small; 128×128 is the minimum', write_failed: 'Could not store the imported icon' }, appIconUnavailable: 'Could not load the app icons', fontSize: { uiLabel: 'UI font size', uiHelp: 'Base font size used across the interface', terminalLabel: 'Terminal font size', terminalHelp: 'Font size used for terminal output and code' },
    },
    pets: {
      import: 'Import PetPack', importing: 'Importing…', loading: 'Loading custom pets…',
      status: 'Desktop pet', activePet: (name) => `Currently using: ${name}`, disabled: 'Off', disable: 'Turn off pet', disabling: 'Turning off…',
      empty: 'No pets imported yet', emptyHelp: 'Choose a local folder containing pet.json and a sprite sheet.',
      selected: 'In use', select: 'Use', selecting: 'Switching…', remove: 'Remove', removing: 'Removing…',
      removeTitle: (name) => `Remove “${name}”?`, removeDescription: 'This removes Maka’s local copy of the pet pack and cannot be undone. The original folder is not affected.', confirmRemove: 'Remove', cancel: 'Cancel',
      loadFailed: 'Could not load custom pets', importFailed: 'Could not import pet', selectFailed: 'Could not switch pet', removeFailed: 'Could not remove pet',
      importErrors: { invalid_directory: 'The selected folder is invalid.', invalid_manifest: 'pet.json does not match the maka.pet/v1 format.', invalid_asset: 'The sprite sheet is missing, invalid, or outside the supported limits.', already_installed: 'A pet with the same ID is already installed.', read_failed: 'The selected folder could not be read.' },
      selectErrors: { invalid_id: 'The pet ID is invalid.', not_found: 'That pet is no longer in the local library.', read_failed: 'The pet library could not be read.', write_failed: 'The pet selection could not be saved.' },
      removeErrors: { invalid_id: 'The pet ID is invalid.', remove_failed: 'The local pet pack could not be removed.' },
    },
    general: {
      incognito: 'Incognito mode', incognitoHelp: 'Pause local memory, web search, and scheduled task triggers.', enableIncognito: 'Enable incognito mode', incognitoFailed: 'Could not change incognito mode', notifications: 'Send a system notification when finished', notificationsHelp: 'Notify when a response finishes or fails while the window is in the background.', notificationsFailed: 'Could not change notification settings', workspaceInstructions: 'Follow project instructions', workspaceInstructionsHelp: 'Automatically read existing AGENTS.md, CLAUDE.md, or GEMINI.md files in each project. Manage the files in their respective projects.', workspaceInstructionsFailed: 'Could not change project instruction settings', workHub: 'Enable WorkHub', workHubHelp: 'WorkHub is not available yet. This toggle is for development testing and does not enable a usable feature.', workHubFailed: 'Could not change WorkHub setting', updateFailed: 'The setting was not applied. Try again later.', defaultModel: 'Default model', defaultModelHelp: 'Model used by new tasks.', notSet: 'Not set', saveDefaultModelFailed: 'Could not save the default model', defaultPermission: 'Default permission mode', defaultPermissionHelp: 'Initial permission mode for new tasks; it can be changed at any time.', saveDefaultPermissionFailed: 'Could not save the default permission mode', defaultThinking: 'Default thinking level', defaultThinkingHelp: 'Thinking level for new tasks; models that do not offer the chosen level use their own default.', followModelDefault: 'Follow model default', saveDefaultThinkingFailed: 'Could not save the default thinking level', proxy: 'Proxy server', proxyHelp: 'Configure a network proxy for AI model requests', enableProxy: 'Enable proxy server', saveNetworkFailed: 'Could not save network settings', proxyProtocol: 'Proxy protocol', serverAddress: 'Server address', port: 'Port', proxyAuth: 'Proxy authentication', proxyAuthHelp: 'Enable this when a username and password are required.', enableProxyAuth: 'Enable proxy authentication', username: 'Username', password: 'Password', bypassList: 'Proxy bypass list', bypassHelp: 'These domains connect directly. Separate multiple domains with commas.', autoBypass: (count) => `${count} ${count === 1 ? 'domain was' : 'domains were'} added automatically. The proxy applies to AI model requests only.`, testing: 'Testing…', testCurrent: 'Test current configuration', proxyReachable: 'Proxy is reachable', proxyTestFailed: 'Proxy test failed', proxyTestError: 'Could not test proxy',
      shellPreference: 'Bash tool shell', shellPreferenceHelp: 'Automatic keeps the PowerShell-first Windows default. Git Bash is an explicit override for the current Runtime Host.', shellAuto: 'Automatic (recommended)', shellGitBash: 'Git Bash', shellExecutable: 'Git Bash executable', shellExecutableHelp: 'Enter the absolute path to bash.exe on the Windows machine running the Runtime Host. The legacy System32 WSL Bash shim is also recognized; Maka verifies GNU Bash before saving.', saveShell: 'Save shell setting', savingShell: 'Saving…', shellSaved: 'Saved', saveShellFailed: 'Could not save shell setting', shellExecutableRejected: 'The current Runtime Host could not run that path as GNU Bash. Check that the Host runs Windows, the path exists, and the file is named bash.exe.',
      passwordSavedPlaceholder: 'Password saved; enter a new password to replace it',
    },
    about: {
      loadFailed: 'Could not load About information', loading: 'Loading About', unavailable: 'About information is unavailable', copied: 'Diagnostics copied', pasteHint: 'Review the content, then paste it into an issue report', copyFailed: 'Copy failed', clipboardUnavailable: 'The clipboard is unavailable or access was denied.', devBuild: 'Local development build', nightlyBuild: 'Nightly', buildLabel: 'Build',
      channelSummaries: {
        dev: 'A local development build. It does not check for updates.',
        nightly: 'A daily prerelease build. It updates itself to the latest nightly and replaces a release install.',
        release: 'The official release build. It receives stable updates automatically.',
      },
      supportTitle: 'Support',
      copying: 'Copying…', copyDiagnostics: 'Copy diagnostics', copyAction: 'Copy', copyHelp: 'Copy version, platform, a home-redacted workspace path, and recent redacted logs. The report is written only to the clipboard and is never uploaded automatically.',
      reportIssueLabel: 'Report an issue', reportIssueHelp: 'Open a GitHub issue with your diagnostics attached — replies come faster.', reportIssueOpen: 'Open',
      keyboardShortcuts: 'Keyboard shortcuts', keyboardShortcutsHelp: 'Every shortcut Maka responds to.', keyboardShortcutsOpen: 'View',
      privacyLabel: 'Privacy commitments', privacyTitle: 'Local first · Private by default', privacyPoints: ['Tasks, settings, credentials, and Skill instructions stay on this machine; model keys live in a local credential file and subscription tokens use secure system storage.', 'Maka sends no usage telemetry and contacts a model provider only when you enable it.', 'High-risk tool operations require explicit permission in the task; messages, tool calls, permission decisions, and mode changes are retained locally for each task.'],
      checkForUpdates: 'Check for updates',
      checkingForUpdates: 'Checking…',
      updateIdle: 'No update check has run yet.',
      updateNotAvailable: 'You are on the latest version.',
      updateAvailable: (version) => `Version v${version} is available and will download shortly…`,
      updateDownloading: (version, percent) => `Downloading v${version} (${percent}%)…`,
      updateVerifying: (version) => `Verifying the release provenance for v${version}…`,
      updateDownloaded: (version) => `v${version} is ready. Restart from the sidebar to install.`,
      updateInstalling: (version) => `Installing v${version}…`,
      updateCheckFailed: 'Could not check for updates',
      updateCheckFailedDetail: (message) => message,
    },
    password: { copyFailed: 'Copy failed', clipboardUnavailable: 'The clipboard is unavailable or access was denied.', copying: 'Copying', copied: 'Copied', copy: 'Copy', hide: 'Hide', show: 'Show', value: 'credential value' },
  },
} satisfies UiCatalog<SettingsPreferencesCopy>;

export function getSettingsPreferencesCopy(locale: UiLocale): SettingsPreferencesCopy {
  return SETTINGS_PREFERENCES_COPY_BY_LOCALE[locale];
}
