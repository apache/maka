import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

/**
 * 设置 › 活动 › 导入任务.
 *
 * The source items are another agent's conversations, so they stay 对话 /
 * conversation; what lands in Maka is a 任务 / task. The page's own title and
 * one-line description live in the settings navigation copy, like every other
 * settings page's.
 */
type ExternalSessionImportCopy = {
  sourceLabel: string;
  codex: string;
  includeArchived: string;
  loading: string;
  listAria: string;
  emptyTitle: string;
  emptyDescription: string;
  unavailableTitle: string;
  unavailableDescription: string;
  loadFailedTitle: string;
  loadFailedFallback: string;
  retry: string;
  archived: string;
  loadMore: string;
  loadingMore: string;
  duplicateNote: string;
  import: string;
  importTask: (name: string) => string;
  importing: string;
  importFailedTitle: string;
  importFailedFallback: string;
  importOutcomeUnknownTitle: string;
  importOutcomeUnknownDescription: string;
};

const COPY = {
  zh: {
    sourceLabel: '来源',
    codex: 'Codex',
    includeArchived: '包含已归档的对话',
    loading: '正在读取外部对话…',
    listAria: '可导入的对话',
    emptyTitle: '没有可导入的对话',
    emptyDescription: '当前来源中没有找到符合条件的根对话。',
    unavailableTitle: '没有检测到支持的 Agent',
    unavailableDescription: 'Maka 会在本机读取 Codex 的对话目录，不会修改其中的文件。',
    loadFailedTitle: '无法读取外部对话',
    loadFailedFallback: '外部对话目录暂时无法读取，请重试。',
    retry: '重试',
    archived: '已归档',
    loadMore: '加载更多',
    loadingMore: '正在加载…',
    duplicateNote: '再次导入同一个对话会创建一个独立的任务。',
    import: '导入',
    importTask: (name) => `导入「${name}」`,
    importing: '正在导入…',
    importFailedTitle: '导入失败',
    importFailedFallback: '该对话无法转换或保存。请检查来源后重试。',
    importOutcomeUnknownTitle: '需要确认导入结果',
    importOutcomeUnknownDescription:
      '导入结果暂时无法确认。请先在任务列表中查找这个对话；如果它已经出现，请不要再次导入。',
  },
  en: {
    sourceLabel: 'Source',
    codex: 'Codex',
    includeArchived: 'Include archived conversations',
    loading: 'Reading external conversations…',
    listAria: 'Conversations available to import',
    emptyTitle: 'No conversations to import',
    emptyDescription: 'No matching root conversations were found in this source.',
    unavailableTitle: 'No supported Agent detected',
    unavailableDescription: "Maka reads Codex's local session directory without modifying its files.",
    loadFailedTitle: 'Could not read external conversations',
    loadFailedFallback: 'The external session directory is temporarily unavailable. Try again.',
    retry: 'Retry',
    archived: 'Archived',
    loadMore: 'Load more',
    loadingMore: 'Loading…',
    duplicateNote: 'Importing the same conversation again creates an independent task.',
    import: 'Import',
    importTask: (name) => `Import ${name}`,
    importing: 'Importing…',
    importFailedTitle: 'Import failed',
    importFailedFallback: 'This conversation could not be converted or saved. Check the source and try again.',
    importOutcomeUnknownTitle: 'Check the import result',
    importOutcomeUnknownDescription:
      'Maka could not confirm whether the import completed. Look for this conversation in the task list first; if it is already there, do not import it again.',
  },
} satisfies UiCatalog<ExternalSessionImportCopy>;

export function getExternalSessionImportCopy(locale: UiLocale): ExternalSessionImportCopy {
  return COPY[locale];
}
