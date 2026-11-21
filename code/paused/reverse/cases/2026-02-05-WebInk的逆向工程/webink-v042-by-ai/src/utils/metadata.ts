// ========================================
// WebInk v0.4.9 - 元数据提取工具
// ========================================

import type { PageMetadata } from "../types";

/** 从页面提取元数据 */
export function extractMetadata(document: Document): PageMetadata {
  const metadata: PageMetadata = {};

  // 提取作者
  const authorMeta = document.querySelector('meta[name="author"]');
  if (authorMeta) {
    metadata.author = authorMeta.getAttribute("content") || undefined;
  }

  // 提取发布时间
  const publishedTimeMeta = document.querySelector('meta[property="article:published_time"]');
  if (publishedTimeMeta) {
    metadata.publishedTime = publishedTimeMeta.getAttribute("content") || undefined;
  }

  // 提取修改时间
  const modifiedTimeMeta = document.querySelector('meta[property="article:modified_time"]');
  if (modifiedTimeMeta) {
    metadata.modifiedTime = modifiedTimeMeta.getAttribute("content") || undefined;
  }

  // 提取描述
  const descriptionMeta = document.querySelector('meta[name="description"]');
  if (descriptionMeta) {
    metadata.description = descriptionMeta.getAttribute("content") || undefined;
  }

  // 提取关键词
  const keywordsMeta = document.querySelector('meta[name="keywords"]');
  if (keywordsMeta) {
    const keywords = keywordsMeta.getAttribute("content");
    if (keywords) {
      metadata.keywords = keywords.split(",").map((k) => k.trim());
    }
  }

  // 提取站点名称
  const siteNameMeta = document.querySelector('meta[property="og:site_name"]');
  if (siteNameMeta) {
    metadata.siteName = siteNameMeta.getAttribute("content") || undefined;
  }

  // 提取图标
  const faviconLink = document.querySelector('link[rel="icon"]') ||
                      document.querySelector('link[rel="shortcut icon"]');
  if (faviconLink) {
    metadata.favicon = faviconLink.getAttribute("href") || undefined;
  }

  return metadata;
}
