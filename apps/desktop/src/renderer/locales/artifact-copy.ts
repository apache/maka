import type { UiCatalog, UiLocale } from '@maka/core';

type ReasonCopy = { title: string; description: string };

export type ArtifactCopy = {
  pane: {
    refreshFailed: string;
    openFailed: string;
    copyFailed: string;
    readTextFailed: string;
    copied: string;
    saved: string;
    saveFailed: string;
    fallbackName: string;
    deleteTitle(name: string): string;
    deleteDescription: string;
    delete: string;
    cancel: string;
    deleted(name: string): string;
    deleteFailed(name: string): string;
    panelAria: string;
    listLoadFailed: string;
    retrying: string;
    retry: string;
    listAria: string;
    deletedBadge: string;
    previewNamed(name: string): string;
    previewAria: string;
    notSelected: string;
    empty: string;
    selectHint: string;
    emptyHint: string;
    actionsAria: string;
    opening: string;
    openInFinder: string;
    saving: string;
    saveAs: string;
    copying: string;
    copy: string;
    deleting: string;
    runtimeArchiveReadOnly: string;
    saveFailures: Record<'not_found' | 'not_allowed' | 'deleted' | 'write_failed' | 'default', string>;
    actionFailed: string;
  };
  preview: {
    loadingFile: string;
    loadingDiff: string;
    loadingHtml: string;
    externalLinks(count: number): string;
    frameTitle(name: string): string;
    loadingPdf: string;
    pdfFallback: string;
    readFailed: ReasonCopy;
    notAllowed: ReasonCopy;
    tooLarge(bytes: number): ReasonCopy;
    deleted: ReasonCopy;
    unsupportedMime: ReasonCopy;
  };
  registry: {
    kindDisallowed: ReasonCopy;
    mimeDisallowed: ReasonCopy;
    unknownType: ReasonCopy;
    oversize: ReasonCopy;
    readFailed: ReasonCopy;
    unsupported: string;
    name: string;
    unnamed: string;
    type: string;
    size: string;
    openInFinder: string;
    loadingImage: string;
  };
};

const ARTIFACT_COPY = {
  zh: {
    pane: {
      refreshFailed: '刷新生成文件失败', openFailed: '无法在 Finder 中打开生成文件', copyFailed: '复制失败',
      readTextFailed: '无法读取生成文件文本内容。', copied: '已复制生成文件文本', saved: '已另存生成文件', saveFailed: '另存失败',
      fallbackName: '生成文件', deleteTitle: (name) => `删除 "${name}"`, deleteDescription: '软删除：在记录中标记为已删除，文件保留 6 小时可恢复。',
      delete: '删除', cancel: '取消', deleted: (name) => `已删除 ${name}`, deleteFailed: (name) => `删除 ${name} 失败`, panelAria: '生成文件预览面板',
      listLoadFailed: '生成文件列表载入失败', retrying: '重试中…', retry: '重试', listAria: '生成文件列表', deletedBadge: '已删除',
      previewNamed: (name) => `预览 ${name}`, previewAria: '生成文件预览', notSelected: '暂未选中文件', empty: '暂无生成文件',
      selectHint: '从上方列表选择文件查看预览。', emptyHint: '助手生成文件后会显示在这里。', actionsAria: '生成文件操作',
      opening: '打开中…', openInFinder: '在 Finder 中打开', saving: '另存中…', saveAs: '另存为', copying: '复制中…', copy: '复制', deleting: '删除中…', runtimeArchiveReadOnly: '运行时归档是只读执行证据，不能从这里删除',
      saveFailures: { not_found: '生成文件不存在。', not_allowed: '生成文件路径检查未通过。', deleted: '生成文件已删除，不能另存。', write_failed: '目标位置无法写入。', default: '无法保存生成文件。' },
      actionFailed: '生成文件操作失败，请稍后重试。',
    },
    preview: {
      loadingFile: '加载文件预览…', loadingDiff: '加载 diff 预览…', loadingHtml: '加载 HTML 预览…',
      externalLinks: (count) => `此预览中已禁用外部链接 · ${count} 个链接`, frameTitle: (name) => `生成文件预览 · ${name}`,
      loadingPdf: '加载 PDF 预览…', pdfFallback: '如果浏览器没有内置 PDF 渲染，请使用工具栏的「在 Finder 中打开」查看。',
      readFailed: { title: '无法读取生成文件', description: '路径可能已被外部删除。请通过工具栏「在 Finder 中打开」检查文件位置。' },
      notAllowed: { title: '无法读取生成文件', description: '路径检查未通过，文件已不在允许预览的生成文件目录内。' },
      tooLarge: (bytes) => ({ title: '文件超出预览大小', description: `${bytes} 字节超过文本预览阈值，请通过工具栏「在 Finder 中打开」查看完整内容。` }),
      deleted: { title: '此生成文件已删除', description: '预览已停止。如需查看原文件请使用「在 Finder 中打开」。' },
      unsupportedMime: { title: '不支持的文件类型', description: '该生成文件的 MIME 类型不在内联预览允许列表中。请使用工具栏「在 Finder 中打开」或「另存为」。' },
    },
    registry: {
      kindDisallowed: { title: '当前预览暂不支持该类型', description: '此类生成文件不能在面板内直接预览。请使用工具栏「在 Finder 中打开」查看。' },
      mimeDisallowed: { title: '格式暂不支持预览', description: '已识别到文件的 MIME 类型，但当前预览只支持 PNG / JPEG / GIF / WebP / AVIF。' },
      unknownType: { title: '无法识别文件类型', description: '文件没有 MIME 元数据，扩展名也未匹配。请通过工具栏「在 Finder 中打开」查看。' },
      oversize: { title: '文件过大，暂不预览', description: '为避免在内存中加载大体积图片，超过 2 MB 的文件不在此处展开预览。' },
      readFailed: { title: '加载预览失败', description: '无法读取文件内容（可能已被删除、移动或权限不足）。请通过工具栏「在 Finder 中打开」检查文件。' },
      unsupported: '暂不支持的预览', name: '名称', unnamed: '(未命名)', type: '类型', size: '大小', openInFinder: '在 Finder 中打开', loadingImage: '加载图片预览…',
    },
  },
  en: {
    pane: {
      refreshFailed: 'Failed to refresh generated files', openFailed: 'Could not show generated file in Finder', copyFailed: 'Copy failed',
      readTextFailed: 'Could not read the generated file as text.', copied: 'Generated file text copied', saved: 'Generated file saved as', saveFailed: 'Save as failed',
      fallbackName: 'generated file', deleteTitle: (name) => `Delete "${name}"`, deleteDescription: 'Soft delete: mark this record as deleted and keep the file recoverable for 6 hours.',
      delete: 'Delete', cancel: 'Cancel', deleted: (name) => `Deleted ${name}`, deleteFailed: (name) => `Failed to delete ${name}`, panelAria: 'Generated file preview panel',
      listLoadFailed: 'Failed to load generated files', retrying: 'Retrying…', retry: 'Retry', listAria: 'Generated files', deletedBadge: 'Deleted',
      previewNamed: (name) => `Preview ${name}`, previewAria: 'Generated file preview', notSelected: 'No file selected', empty: 'No generated files',
      selectHint: 'Select a file from the list above to preview it.', emptyHint: 'Files generated by the assistant appear here.', actionsAria: 'Generated file actions',
      opening: 'Opening…', openInFinder: 'Show in Finder', saving: 'Saving…', saveAs: 'Save as', copying: 'Copying…', copy: 'Copy', deleting: 'Deleting…', runtimeArchiveReadOnly: 'Runtime archives are read-only execution evidence and cannot be deleted here',
      saveFailures: { not_found: 'The generated file does not exist.', not_allowed: 'The generated file failed the path safety check.', deleted: 'Deleted generated files cannot be saved.', write_failed: 'The destination is not writable.', default: 'Could not save the generated file.' },
      actionFailed: 'The generated file action failed. Try again later.',
    },
    preview: {
      loadingFile: 'Loading file preview…', loadingDiff: 'Loading diff preview…', loadingHtml: 'Loading HTML preview…',
      externalLinks: (count) => `External links are disabled in this preview · ${count} ${count === 1 ? 'link' : 'links'}`, frameTitle: (name) => `Generated file preview · ${name}`,
      loadingPdf: 'Loading PDF preview…', pdfFallback: 'If your browser has no built-in PDF viewer, use “Show in Finder” in the toolbar.',
      readFailed: { title: 'Could not read generated file', description: 'The file may have been deleted externally. Use “Show in Finder” in the toolbar to check its location.' },
      notAllowed: { title: 'Could not read generated file', description: 'The path safety check failed because the file is no longer inside the allowed generated-files directory.' },
      tooLarge: (bytes) => ({ title: 'File exceeds preview size', description: `${bytes} bytes exceeds the text preview limit. Use “Show in Finder” in the toolbar to view the full file.` }),
      deleted: { title: 'This generated file was deleted', description: 'The preview has stopped. Use “Show in Finder” to inspect the original file.' },
      unsupportedMime: { title: 'Unsupported file type', description: 'This generated file’s MIME type is not allowed for inline preview. Use “Show in Finder” or “Save as”.' },
    },
    registry: {
      kindDisallowed: { title: 'This type cannot be previewed here', description: 'This generated file cannot be previewed in the panel. Use “Show in Finder” in the toolbar.' },
      mimeDisallowed: { title: 'Preview format not supported', description: 'The MIME type was recognized, but previews currently support only PNG / JPEG / GIF / WebP / AVIF.' },
      unknownType: { title: 'Could not identify file type', description: 'The file has no MIME metadata and its extension did not match. Use “Show in Finder” in the toolbar.' },
      oversize: { title: 'File too large to preview', description: 'Files over 2 MB are not expanded here to avoid loading large images into memory.' },
      readFailed: { title: 'Failed to load preview', description: 'The file could not be read. It may have been deleted, moved, or blocked by permissions. Use “Show in Finder” in the toolbar to inspect it.' },
      unsupported: 'Unsupported preview', name: 'Name', unnamed: '(unnamed)', type: 'Type', size: 'Size', openInFinder: 'Show in Finder', loadingImage: 'Loading image preview…',
    },
  },
} satisfies UiCatalog<ArtifactCopy>;

export function getArtifactCopy(locale: UiLocale): ArtifactCopy {
  return ARTIFACT_COPY[locale];
}
