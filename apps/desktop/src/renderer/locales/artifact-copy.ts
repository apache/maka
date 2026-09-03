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
  ko: {
  pane: {
    refreshFailed: "생성된 파일을 새로 고치지 못했습니다.",
    openFailed: "Finder에서 생성된 파일을 표시할 수 없습니다.",
    copyFailed: "복사 실패",
    readTextFailed: "생성된 파일을 텍스트로 읽을 수 없습니다.",
    copied: "생성된 파일 텍스트가 복사되었습니다.",
    saved: "생성된 파일이 다음 이름으로 저장됨",
    saveFailed: "다른 이름으로 저장 실패",
    fallbackName: "생성된 파일",
    deleteTitle: name => `"${name}" 삭제`,
    deleteDescription: "일시 삭제: 이 기록을 삭제된 것으로 표시하고 파일을 6시간 동안 복구 가능하게 유지합니다.",
    delete: "삭제",
    deleteReadOnly: "삭제(읽기 전용 파일)",
    cancel: "취소",
    deleted: name => `${name} 삭제됨`,
    deleteFailed: name => `${name}을(를) 삭제하지 못했습니다.`,
    panelAria: "생성된 파일 미리보기 패널",
    listLoadFailed: "생성된 파일을 로드하지 못했습니다.",
    retrying: "재시도 중…",
    retry: "다시 해 보다",
    listAria: "생성된 파일",
    deletedBadge: "삭제됨",
    previewNamed: name => `미리보기 ${name}`,
    empty: "생성된 파일 없음",
    emptyHint: "어시스턴트가 생성한 파일이 여기에 표시됩니다.",
    back: "생성된 파일로 돌아가기",
    moreActions: name => `${name}에 대한 추가 작업`,
    openInFinder: "Finder에 표시",
    saveAs: "다른 이름으로 저장",
    copy: "복사",
    saveFailures: {
      not_found: "생성된 파일이 존재하지 않습니다.",
      not_allowed: "생성된 파일이 경로 안전 검사에 실패했습니다.",
      deleted: "삭제된 생성 파일은 저장할 수 없습니다.",
      write_failed: "대상에 쓸 수 없습니다.",
      default: "생성된 파일을 저장할 수 없습니다."
    },
    actionFailed: "생성된 파일 작업이 실패했습니다. 나중에 다시 시도하세요."
  },
  preview: {
    loadingFile: "파일 미리보기 로드 중…",
    loadingDiff: "차이점 미리보기 로드 중…",
    loadingHtml: "HTML 미리보기 로드 중…",
    externalLinks: count => `이 미리보기에서는 외부 링크가 비활성화되었습니다. · 외부 링크 ${count}개`,
    frameTitle: name => `생성된 파일 미리보기 · ${name}`,
    loadingPdf: "PDF 미리보기 로드 중…",
    pdfFallback: "브라우저에 PDF 뷰어가 내장되어 있지 않은 경우 자세히 메뉴에서 \"Finder에 표시\"를 사용하세요.",
    rendered: "시사",
    source: "원천",
    previewLimited: limit => `첫 번째 ${limit}을 표시합니다. 전체 파일을 열거나 저장하려면 자세히 메뉴를 사용하세요.`,
    renderLimited: (limit, lines) => `응답성을 유지하기 위해 풍부한 미리보기는 첫 번째 ${limit} 및 ${lines} 줄로 제한됩니다. 전체 소스는 계속 사용 가능합니다.`,
    highlightLimited: (limit, lines) => `응답성을 유지하기 위해 구문 강조 표시는 첫 번째 ${limit} 및 ${lines} 줄로 제한됩니다. 나머지는 일반 텍스트입니다.`,
    diffLinesLimited: count => `${count} 미리보기의 반응성을 유지하기 위해 더 많은 줄이 숨겨졌습니다.`,
    readFailed: {
      title: "생성된 파일을 읽을 수 없습니다.",
      description: "파일이 외부에서 삭제되었을 수 있습니다. 위치를 확인하려면 자세히 메뉴의 \"Finder에 표시\"를 사용하세요."
    },
    notAllowed: {
      title: "생성된 파일을 읽을 수 없습니다.",
      description: "파일이 더 이상 허용된 생성 파일 디렉터리에 없기 때문에 경로 안전 확인에 실패했습니다."
    },
    tooLarge: bytes => ({
      title: "파일이 미리보기 크기를 초과합니다.",
      description: `${bytes}바이트가 텍스트 미리보기 제한을 초과합니다. 전체 파일을 열거나 저장하려면 자세히 메뉴를 사용하세요.`
    }),
    deleted: {
      title: "생성된 파일이 삭제되었습니다.",
      description: "미리보기가 중지되었습니다. 원본 파일을 검사하려면 \"Finder에 표시\"를 사용하세요."
    },
    unsupportedMime: {
      title: "지원되지 않는 파일 형식",
      description: "이 생성된 파일의 MIME 유형은 인라인 미리보기에 허용되지 않습니다. \"Finder에 표시\" 또는 \"다른 이름으로 저장\"을 사용하세요."
    }
  },
  registry: {
    kindDisallowed: {
      title: "이 유형은 여기에서 미리 볼 수 없습니다.",
      description: "생성된 파일은 패널에서 미리 볼 수 없습니다. \"Finder에 표시\"를 사용하세요."
    },
    mimeDisallowed: {
      title: "미리보기 형식은 지원되지 않습니다.",
      description: "MIME 유형이 인식되었지만 현재 미리보기는 PNG/JPEG/GIF/WebP/AVIF만 지원합니다."
    },
    unknownType: {
      title: "파일 형식을 식별할 수 없습니다.",
      description: "파일에 MIME 메타데이터가 없으며 확장자가 일치하지 않습니다. \"Finder에 표시\"를 사용하세요."
    },
    oversize: {
      title: "파일이 너무 커서 미리 볼 수 없음",
      description: "큰 이미지가 메모리에 로드되는 것을 방지하기 위해 2MB가 넘는 파일은 여기에서 확장되지 않습니다."
    },
    readFailed: {
      title: "미리보기를 로드하지 못했습니다.",
      description: "파일을 읽을 수 없습니다. 권한에 의해 삭제, 이동 또는 차단되었을 수 있습니다. \"Finder에 표시\"를 사용하여 검사하십시오."
    },
    unsupported: "지원되지 않는 미리보기",
    name: "이름",
    unnamed: "(이름 없음)",
    type: "유형",
    size: "크기",
    openInFinder: "Finder에 표시",
    loadingImage: "이미지 미리보기 로드 중…"
  }
}
} satisfies UiCatalog<ArtifactCopy>;

export function getArtifactCopy(locale: UiLocale): ArtifactCopy {
  return ARTIFACT_COPY[locale];
}
