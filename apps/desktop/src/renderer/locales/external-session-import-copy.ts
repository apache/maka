import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

type ExternalSessionImportCopy = {
  title: string;
  description: string;
  sourceLabel: string;
  codex: string;
  includeArchived: string;
  loading: string;
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
  cancel: string;
  import: string;
  importing: string;
  importFailedTitle: string;
  importFailedFallback: string;
  importOutcomeUnknownTitle: string;
  importOutcomeUnknownDescription: string;
};

const COPY = {
  zh: {
    title: '导入外部会话',
    description: '选择一个本机 Agent 会话，将原始对话记录转换为 Maka 会话。',
    sourceLabel: '来源',
    codex: 'Codex',
    includeArchived: '包含已归档会话',
    loading: '正在读取外部会话…',
    emptyTitle: '没有可导入的会话',
    emptyDescription: '当前来源中没有找到符合条件的根会话。',
    unavailableTitle: '没有检测到支持的 Agent',
    unavailableDescription: 'Maka 会在本机读取 Codex 的会话目录，不会修改其中的文件。',
    loadFailedTitle: '无法读取外部会话',
    loadFailedFallback: '外部会话目录暂时无法读取，请重试。',
    retry: '重试',
    archived: '已归档',
    loadMore: '加载更多',
    loadingMore: '正在加载…',
    duplicateNote: '再次导入同一会话会创建一个独立副本。',
    cancel: '取消',
    import: '导入会话',
    importing: '正在导入…',
    importFailedTitle: '导入失败',
    importFailedFallback: '该会话无法转换或保存。请检查来源后重试。',
    importOutcomeUnknownTitle: '需要确认导入结果',
    importOutcomeUnknownDescription:
      '导入结果暂时无法确认。请先关闭此窗口并检查 Maka 会话列表；如果会话已经出现，请不要再次导入。',
  },
  en: {
    title: 'Import external conversation',
    description: 'Choose a local Agent conversation and convert its raw history into a Maka Session.',
    sourceLabel: 'Source',
    codex: 'Codex',
    includeArchived: 'Include archived conversations',
    loading: 'Reading external conversations…',
    emptyTitle: 'No conversations to import',
    emptyDescription: 'No matching root conversations were found in this source.',
    unavailableTitle: 'No supported Agent detected',
    unavailableDescription: "Maka reads Codex's local Session directory without modifying its files.",
    loadFailedTitle: 'Could not read external conversations',
    loadFailedFallback: 'The external Session directory is temporarily unavailable. Try again.',
    retry: 'Retry',
    archived: 'Archived',
    loadMore: 'Load more',
    loadingMore: 'Loading…',
    duplicateNote: 'Importing the same conversation again creates an independent copy.',
    cancel: 'Cancel',
    import: 'Import conversation',
    importing: 'Importing…',
    importFailedTitle: 'Import failed',
    importFailedFallback: 'This conversation could not be converted or saved. Check the source and try again.',
    importOutcomeUnknownTitle: 'Check the import result',
    importOutcomeUnknownDescription:
      'Maka could not confirm whether the import completed. Close this window and check the Maka Session list. If the Session appears there, do not import it again.',
  },
} satisfies UiCatalog<ExternalSessionImportCopy>;

export function getExternalSessionImportCopy(locale: UiLocale): ExternalSessionImportCopy {
  return COPY[locale];
}
