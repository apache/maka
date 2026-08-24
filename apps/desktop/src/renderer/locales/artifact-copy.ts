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
    deleteReadOnly: string;
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
    empty: string;
    emptyHint: string;
    back: string;
    moreActions(name: string): string;
    openInFinder: string;
    saveAs: string;
    copy: string;
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
    rendered: string;
    source: string;
    previewLimited(limit: string): string;
    renderLimited(limit: string, lines: number): string;
    highlightLimited(limit: string, lines: number): string;
    diffLinesLimited(count: number): string;
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
      delete: '删除', deleteReadOnly: '删除（只读文件）', cancel: '取消', deleted: (name) => `已删除 ${name}`, deleteFailed: (name) => `删除 ${name} 失败`, panelAria: '生成文件预览面板',
      listLoadFailed: '生成文件列表载入失败', retrying: '重试中…', retry: '重试', listAria: '生成文件列表', deletedBadge: '已删除',
      previewNamed: (name) => `预览 ${name}`, empty: '暂无生成文件', emptyHint: '助手生成文件后会显示在这里。',
      back: '返回生成文件列表', moreActions: (name) => `${name} 的更多操作`,
      openInFinder: '在 Finder 中打开', saveAs: '另存为', copy: '复制',
      saveFailures: { not_found: '生成文件不存在。', not_allowed: '生成文件路径检查未通过。', deleted: '生成文件已删除，不能另存。', write_failed: '目标位置无法写入。', default: '无法保存生成文件。' },
      actionFailed: '生成文件操作失败，请稍后重试。',
    },
    preview: {
      loadingFile: '加载文件预览…', loadingDiff: '加载 diff 预览…', loadingHtml: '加载 HTML 预览…',
      externalLinks: (count) => `此预览中已禁用外部链接 · ${count} 个链接`, frameTitle: (name) => `生成文件预览 · ${name}`,
      loadingPdf: '加载 PDF 预览…', pdfFallback: '如果浏览器没有内置 PDF 渲染，请通过更多菜单「在 Finder 中打开」查看。',
      rendered: '预览', source: '源码', previewLimited: (limit) => `仅显示前 ${limit}；可通过更多菜单打开或另存完整文件。`,
      renderLimited: (limit, lines) => `为保证流畅，富文本预览仅展开前 ${limit}、最多 ${lines} 行；完整源码仍可查看。`,
      highlightLimited: (limit, lines) => `为保证流畅，仅高亮前 ${limit}、最多 ${lines} 行，其余内容以纯文本显示。`,
      diffLinesLimited: (count) => `为保证流畅，另有 ${count} 行未在预览中展开。`,
      readFailed: { title: '无法读取生成文件', description: '路径可能已被外部删除。请通过更多菜单「在 Finder 中打开」检查文件位置。' },
      notAllowed: { title: '无法读取生成文件', description: '路径检查未通过，文件已不在允许预览的生成文件目录内。' },
      tooLarge: (bytes) => ({ title: '文件超出预览大小', description: `${bytes} 字节超过文本预览阈值，请通过更多菜单打开或另存完整内容。` }),
      deleted: { title: '此生成文件已删除', description: '预览已停止。如需查看原文件请使用「在 Finder 中打开」。' },
      unsupportedMime: { title: '不支持的文件类型', description: '该生成文件的 MIME 类型不在内联预览允许列表中。请使用工具栏「在 Finder 中打开」或「另存为」。' },
    },
    registry: {
      kindDisallowed: { title: '当前预览暂不支持该类型', description: '此类生成文件不能在面板内直接预览。请使用「在 Finder 中打开」查看。' },
      mimeDisallowed: { title: '格式暂不支持预览', description: '已识别到文件的 MIME 类型，但当前预览只支持 PNG / JPEG / GIF / WebP / AVIF。' },
      unknownType: { title: '无法识别文件类型', description: '文件没有 MIME 元数据，扩展名也未匹配。请通过「在 Finder 中打开」查看。' },
      oversize: { title: '文件过大，暂不预览', description: '为避免在内存中加载大体积图片，超过 2 MB 的文件不在此处展开预览。' },
      readFailed: { title: '加载预览失败', description: '无法读取文件内容（可能已被删除、移动或权限不足）。请通过「在 Finder 中打开」检查文件。' },
      unsupported: '暂不支持的预览', name: '名称', unnamed: '(未命名)', type: '类型', size: '大小', openInFinder: '在 Finder 中打开', loadingImage: '加载图片预览…',
    },
  },
  en: {
    pane: {
      refreshFailed: 'Failed to refresh generated files', openFailed: 'Could not show generated file in Finder', copyFailed: 'Copy failed',
      readTextFailed: 'Could not read the generated file as text.', copied: 'Generated file text copied', saved: 'Generated file saved as', saveFailed: 'Save as failed',
      fallbackName: 'generated file', deleteTitle: (name) => `Delete "${name}"`, deleteDescription: 'Soft delete: mark this record as deleted and keep the file recoverable for 6 hours.',
      delete: 'Delete', deleteReadOnly: 'Delete (read-only file)', cancel: 'Cancel', deleted: (name) => `Deleted ${name}`, deleteFailed: (name) => `Failed to delete ${name}`, panelAria: 'Generated file preview panel',
      listLoadFailed: 'Failed to load generated files', retrying: 'Retrying…', retry: 'Retry', listAria: 'Generated files', deletedBadge: 'Deleted',
      previewNamed: (name) => `Preview ${name}`, empty: 'No generated files', emptyHint: 'Files generated by the assistant appear here.',
      back: 'Back to generated files', moreActions: (name) => `More actions for ${name}`,
      openInFinder: 'Show in Finder', saveAs: 'Save as', copy: 'Copy',
      saveFailures: { not_found: 'The generated file does not exist.', not_allowed: 'The generated file failed the path safety check.', deleted: 'Deleted generated files cannot be saved.', write_failed: 'The destination is not writable.', default: 'Could not save the generated file.' },
      actionFailed: 'The generated file action failed. Try again later.',
    },
    preview: {
      loadingFile: 'Loading file preview…', loadingDiff: 'Loading diff preview…', loadingHtml: 'Loading HTML preview…',
      externalLinks: (count) => `External links are disabled in this preview · ${count} ${count === 1 ? 'link' : 'links'}`, frameTitle: (name) => `Generated file preview · ${name}`,
      loadingPdf: 'Loading PDF preview…', pdfFallback: 'If your browser has no built-in PDF viewer, use “Show in Finder” in the More menu.',
      rendered: 'Preview', source: 'Source', previewLimited: (limit) => `Showing the first ${limit}. Use the More menu to open or save the complete file.`,
      renderLimited: (limit, lines) => `To stay responsive, rich preview is limited to the first ${limit} and ${lines} lines. The complete source remains available.`,
      highlightLimited: (limit, lines) => `To stay responsive, syntax highlighting is limited to the first ${limit} and ${lines} lines; the rest is plain text.`,
      diffLinesLimited: (count) => `${count} more lines are hidden to keep the preview responsive.`,
      readFailed: { title: 'Could not read generated file', description: 'The file may have been deleted externally. Use “Show in Finder” in the More menu to check its location.' },
      notAllowed: { title: 'Could not read generated file', description: 'The path safety check failed because the file is no longer inside the allowed generated-files directory.' },
      tooLarge: (bytes) => ({ title: 'File exceeds preview size', description: `${bytes} bytes exceeds the text preview limit. Use the More menu to open or save the complete file.` }),
      deleted: { title: 'This generated file was deleted', description: 'The preview has stopped. Use “Show in Finder” to inspect the original file.' },
      unsupportedMime: { title: 'Unsupported file type', description: 'This generated file’s MIME type is not allowed for inline preview. Use “Show in Finder” or “Save as”.' },
    },
    registry: {
      kindDisallowed: { title: 'This type cannot be previewed here', description: 'This generated file cannot be previewed in the panel. Use “Show in Finder”.' },
      mimeDisallowed: { title: 'Preview format not supported', description: 'The MIME type was recognized, but previews currently support only PNG / JPEG / GIF / WebP / AVIF.' },
      unknownType: { title: 'Could not identify file type', description: 'The file has no MIME metadata and its extension did not match. Use “Show in Finder”.' },
      oversize: { title: 'File too large to preview', description: 'Files over 2 MB are not expanded here to avoid loading large images into memory.' },
      readFailed: { title: 'Failed to load preview', description: 'The file could not be read. It may have been deleted, moved, or blocked by permissions. Use “Show in Finder” to inspect it.' },
      unsupported: 'Unsupported preview', name: 'Name', unnamed: '(unnamed)', type: 'Type', size: 'Size', openInFinder: 'Show in Finder', loadingImage: 'Loading image preview…',
    },
  },
} satisfies UiCatalog<ArtifactCopy>;

export function getArtifactCopy(locale: UiLocale): ArtifactCopy {
  return ARTIFACT_COPY[locale];
}
