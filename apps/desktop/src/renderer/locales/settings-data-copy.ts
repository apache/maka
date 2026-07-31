import type { UiCatalog, UiLocale } from '@maka/core';
import type { ConfigCategory } from '@maka/storage';

export type DataSettingsCopy = {
  categories: Record<ConfigCategory, { label: string; detail: string; sensitive?: boolean }>;
  importSummary: {
    connections(created: number, overwritten: number, skipped: number): string;
    settings: string; credentials(applied: number, skipped: number): string; memory: string; empty: string;
  };
  loadFailed: string; openFailed(label: string): string; pathCopied: string; copyFailed: string; copyFailedDetail: string;
  historyCleared: string; historyClearedDetail: string; selectCategory: string; exported: string; exportedDetail(items: readonly string[]): string;
  exportFailed: string; noCategories: string; tryAgain: string; imported: string; importFailed: string; invalidFile: string;
  rows: {
    workspace: string; workspaceDetail: string; loadValueFailed: string; loading: string; storage: string; storageDetail: string; localFiles: string;
    history: string; historyDetail: string; localStorage: string;
  };
  actionsAria: string; opening: string; openWorkspace: string; copying: string; copyPath: string; clearing: string; clearHistory: string;
  backupNotice: string; pathLoadFailed(error: string): string; configAria: string; configTitle: string; configHelp: string; categoryAria: string;
  exportCategory(label: string): string; sensitiveWarning: string; importConflict: string; conflictAria: string; skip: string; overwrite: string;
  exporting: string; exportConfig: string; importing: string; importConfig: string;
};

const SETTINGS_DATA_COPY = {
  zh: {
    categories: {
      connections: { label: '模型连接', detail: '供应商连接与默认模型（不含密钥）' },
      settings: { label: '应用设置', detail: '常规、搜索、机器人、代理等设置' },
      memory: { label: '本地记忆', detail: '本机 MEMORY.md 的内容' },
      credentials: { label: '凭据（API 密钥、令牌）', detail: '模型密钥与订阅令牌等敏感信息', sensitive: true },
    },
    importSummary: {
      connections: (created, overwritten, skipped) => `连接 新增${created}·覆盖${overwritten}·跳过${skipped}`,
      settings: '设置已应用', credentials: (applied, skipped) => skipped > 0 ? `凭据 ${applied}（跳过 ${skipped}）` : `凭据 ${applied}`,
      memory: '记忆已应用', empty: '文件不含可导入的内容',
    },
    loadFailed: '载入数据目录失败', openFailed: (label) => `无法打开${label}`, pathCopied: '已复制工作区路径', copyFailed: '复制失败', copyFailedDetail: '剪贴板不可用或被系统拒绝。',
    historyCleared: '已清空输入历史', historyClearedDetail: '已发送的提示词记录已从本机移除。', selectCategory: '请至少选择一个类别',
    exported: '已导出配置', exportedDetail: (items) => `包含：${items.join('、')}`, exportFailed: '导出失败', noCategories: '未选择任何类别', tryAgain: '请稍后重试',
    imported: '已导入配置', importFailed: '导入失败', invalidFile: '文件无效或版本不受支持。',
    rows: {
      workspace: '工作区路径', workspaceDetail: '会话、设置、凭据和技能文件都存在这个目录下。', loadValueFailed: '载入失败', loading: '正在加载…',
      storage: '存储引擎', storageDetail: '会话记录、外观与账号设置、本地使用统计，以及本机凭据文件。', localFiles: '本地文件',
      history: '输入历史', historyDetail: '上箭头 / 下箭头调出的已发送提示词记录，保存在浏览器本地存储里，跨重启保留。清空后无法恢复。', localStorage: '本机 localStorage',
    },
    actionsAria: '工作区数据操作', opening: '打开中…', openWorkspace: '打开工作区文件夹', copying: '复制中…', copyPath: '复制路径', clearing: '清空中…', clearHistory: '清空输入历史',
    backupNotice: '本机数据保存在工作区。需要备份时先退出 Maka，再复制整个目录；恢复时替换同一路径后重启。模型连接凭据随工作区恢复后需要重新测试；订阅账号令牌通常需要重新登录。',
    pathLoadFailed: (error) => `无法载入工作区路径：${error}`, configAria: '配置导入导出', configTitle: '配置导入导出',
    configHelp: '勾选要导出的内容，生成一个 JSON 备份文件；换机或重装时可再导入。默认不含密钥。', categoryAria: '选择导出内容',
    exportCategory: (label) => `导出${label}`, sensitiveWarning: '⚠️ 密钥将以明文写入导出文件。任何拿到该文件的人都能使用这些密钥，请妥善保管、不要分享。',
    importConflict: '导入时同名连接：', conflictAria: '导入时同名连接的处理方式', skip: '跳过', overwrite: '覆盖', exporting: '导出中…', exportConfig: '导出配置…', importing: '导入中…', importConfig: '导入配置…',
  },
  en: {
    categories: {
      connections: { label: 'Model connections', detail: 'Provider connections and default models (without secrets)' },
      settings: { label: 'App settings', detail: 'General, search, bot, proxy, and other settings' },
      memory: { label: 'Local memory', detail: 'Contents of the local MEMORY.md file' },
      credentials: { label: 'Credentials (API keys and tokens)', detail: 'Sensitive model keys and subscription tokens', sensitive: true },
    },
    importSummary: {
      connections: (created, overwritten, skipped) => `Connections: ${created} created · ${overwritten} overwritten · ${skipped} skipped`,
      settings: 'Settings applied', credentials: (applied, skipped) => skipped > 0 ? `Credentials: ${applied} applied (${skipped} skipped)` : `Credentials: ${applied} applied`,
      memory: 'Memory applied', empty: 'The file contains no importable data',
    },
    loadFailed: 'Failed to load data directory', openFailed: (label) => `Could not open ${label}`, pathCopied: 'Workspace path copied', copyFailed: 'Copy failed', copyFailedDetail: 'The clipboard is unavailable or access was denied by the system.',
    historyCleared: 'Input history cleared', historyClearedDetail: 'Sent prompt history was removed from this device.', selectCategory: 'Select at least one category',
    exported: 'Configuration exported', exportedDetail: (items) => `Included: ${items.join(', ')}`, exportFailed: 'Export failed', noCategories: 'No categories selected', tryAgain: 'Try again later',
    imported: 'Configuration imported', importFailed: 'Import failed', invalidFile: 'The file is invalid or its version is unsupported.',
    rows: {
      workspace: 'Workspace path', workspaceDetail: 'Sessions, settings, credentials, and skill files are stored in this directory.', loadValueFailed: 'Failed to load', loading: 'Loading…',
      storage: 'Storage engine', storageDetail: 'Session history, appearance and account settings, local usage statistics, and local credential files.', localFiles: 'Local files',
      history: 'Input history', historyDetail: 'Previously sent prompts recalled with the Up and Down arrows are stored locally in the browser and persist across restarts. Clearing them cannot be undone.', localStorage: 'Local localStorage',
    },
    actionsAria: 'Workspace data actions', opening: 'Opening…', openWorkspace: 'Open workspace folder', copying: 'Copying…', copyPath: 'Copy path', clearing: 'Clearing…', clearHistory: 'Clear input history',
    backupNotice: 'Local data is stored in the workspace. To back it up, quit Maka and copy the entire directory. To restore it, replace the same path and restart. Model credentials should be tested again after a restore, and subscription accounts usually need to sign in again.',
    pathLoadFailed: (error) => `Could not load workspace path: ${error}`, configAria: 'Configuration import and export', configTitle: 'Configuration import and export',
    configHelp: 'Select the content to export into a JSON backup. You can import it after moving devices or reinstalling. Secrets are excluded by default.', categoryAria: 'Select export content',
    exportCategory: (label) => `Export ${label}`, sensitiveWarning: '⚠️ Secrets will be written to the export file as plain text. Anyone with this file can use them. Store it securely and do not share it.',
    importConflict: 'Connections with the same name:', conflictAria: 'How to handle connections with the same name during import', skip: 'Skip', overwrite: 'Overwrite', exporting: 'Exporting…', exportConfig: 'Export configuration…', importing: 'Importing…', importConfig: 'Import configuration…',
  },
} satisfies UiCatalog<DataSettingsCopy>;

export function getDataSettingsCopy(locale: UiLocale): DataSettingsCopy {
  return SETTINGS_DATA_COPY[locale];
}
