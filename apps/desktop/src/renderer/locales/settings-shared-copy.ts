import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

export type SettingsSharedCopy = {
  modalLabel: string;
  contentLabel: string;
  sidebarLabel: string;
  navigationLabel: string;
  backToApp: string;
  close: string;
  loading: string;
  retry: string;
  save: string;
  cancel: string;
  copy: string;
  copied: string;
  failed: string;
  settingsLoadFailed: string;
  usageLoadFailed: string;
  unknownError: string;
  unavailablePage: string;
  ready: string;
  showDetails: string;
  hideDetails: string;
  /**
   * SettingsSection group titles for pages whose own copy module has no
   * suitable label. Group titles live together (here, and in
   * settings-preferences-copy's `sections`) rather than beside each control's
   * copy: a group names a SET of settings, and keeping the set names adjacent
   * is what makes an inconsistent grouping visible when someone edits one.
   */
  groups: {
    memorySources: string;
    memorySourcesHelp: string;
    searchProvider: string;
    searchProviderHelp: string;
    searchBehavior: string;
    searchBehaviorHelp: string;
    dataLocation: string;
    dataLocationHelp: string;
    memoryDocument: string;
    memoryDocumentHelp: string;
    memoryEntries: string;
    memoryEntriesHelp: string;
    reviewSchedule: string;
    reviewScheduleHelp: string;
    buildInfo: string;
    reference: string;
  };
};

const SETTINGS_SHARED_COPY_BY_LOCALE = {
  zh: {
    modalLabel: '设置',
    contentLabel: '设置内容',
    sidebarLabel: '设置侧栏',
    navigationLabel: '设置分组',
    backToApp: '返回应用',
    close: '关闭',
    loading: '正在加载设置',
    retry: '重试',
    save: '保存',
    cancel: '取消',
    copy: '复制',
    copied: '已复制',
    failed: '失败',
    settingsLoadFailed: '载入设置失败',
    usageLoadFailed: '载入使用统计失败',
    unknownError: '出现错误，请稍后重试。',
    unavailablePage: '该设置页已纳入 Maka 设置树，会随对应 runtime 能力一起工作。',
    showDetails: '展开详情',
    hideDetails: '收起详情',
    ready: '就绪',
    groups: {
      memorySources: '记忆',
      memorySourcesHelp: 'Maka 会在对话中记住你确认过的信息，用于之后的回答。',
      memoryDocument: '记忆文件与备份',
      memoryDocumentHelp: '记忆保存在本机 MEMORY.md 里；这里可以直接编辑原文或恢复备份。',
      memoryEntries: '已记住的内容',
      memoryEntriesHelp: '可以筛选、手动添加，或把不再需要的条目归档。',
      searchProvider: '搜索服务商',
      searchProviderHelp: '联网搜索使用的服务商与凭据。',
      searchBehavior: '搜索行为',
      searchBehaviorHelp: '什么时候发起搜索，以及每次取回多少结果。',
      dataLocation: '数据位置',
      dataLocationHelp: '会话、设置、使用统计与凭据都以文件形式存放在本机的这个位置。',
      reviewSchedule: '回顾计划',
      reviewScheduleHelp: '每日回顾的生成时间与使用的模型。',
      buildInfo: '版本信息',
      reference: '参考',
    },
  },
  en: {
    modalLabel: 'Settings',
    contentLabel: 'Settings content',
    sidebarLabel: 'Settings sidebar',
    navigationLabel: 'Settings sections',
    backToApp: 'Back to app',
    close: 'Close',
    loading: 'Loading settings',
    retry: 'Try again',
    save: 'Save',
    cancel: 'Cancel',
    copy: 'Copy',
    copied: 'Copied',
    failed: 'Failed',
    settingsLoadFailed: 'Could not load settings',
    usageLoadFailed: 'Could not load usage statistics',
    unknownError: 'Something went wrong. Try again.',
    unavailablePage: 'This page is part of the Maka settings tree and will activate with its runtime capability.',
    showDetails: 'Show details',
    hideDetails: 'Hide details',
    ready: 'Ready',
    groups: {
      memorySources: 'Memory',
      memorySourcesHelp: 'Maka remembers information you confirm in chat and uses it in later answers.',
      memoryDocument: 'Memory file and backups',
      memoryDocumentHelp: 'Memory lives in a local MEMORY.md; edit the raw file or restore a backup here.',
      memoryEntries: 'What Maka remembers',
      memoryEntriesHelp: 'Filter entries, add one manually, or archive what is no longer needed.',
      searchProvider: 'Search provider',
      searchProviderHelp: 'The provider and credentials web search uses.',
      searchBehavior: 'Search behavior',
      searchBehaviorHelp: 'When a search runs, and how many results it returns.',
      dataLocation: 'Data location',
      dataLocationHelp: 'Conversations, settings, usage statistics, and credentials are stored as files in this location on your machine.',
      reviewSchedule: 'Review schedule',
      reviewScheduleHelp: 'When the daily review runs, and which model writes it.',
      buildInfo: 'Build info',
      reference: 'Reference',
    },
  },
} satisfies UiCatalog<SettingsSharedCopy>;

export function getSettingsSharedCopy(locale: UiLocale): SettingsSharedCopy {
  return SETTINGS_SHARED_COPY_BY_LOCALE[locale];
}
