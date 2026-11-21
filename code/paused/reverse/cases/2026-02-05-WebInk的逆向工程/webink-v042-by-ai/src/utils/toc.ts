// ========================================
// WebInk v0.4.9 - TOC 生成工具
// ========================================

import type { TOCItem } from "../types";

/** 从 HTML 内容生成目录 */
export function generateTOC(html: string, document: Document): TOCItem[] {
  const tempDiv = document.createElement("div");
  tempDiv.textContent = html;
  const headings = tempDiv.querySelectorAll("h1, h2, h3, h4, h5, h6");

  const toc: TOCItem[] = [];
  const stack: TOCItem[][] = [toc];

  headings.forEach((heading, index) => {
    const level = parseInt(heading.tagName[1]);
    const text = heading.textContent || "";
    const id = `heading-${index}`;

    const item: TOCItem = { text, id, level };

    // 找到正确的父级
    while (stack.length > level) {
      stack.pop();
    }

    const currentLevel = stack[stack.length - 1];
    if (level > 1 && currentLevel.length > 0) {
      const lastItem = currentLevel[currentLevel.length - 1];
      if (!lastItem.children) {
        lastItem.children = [];
      }
      lastItem.children.push(item);
      stack.push(lastItem.children);
    } else {
      currentLevel.push(item);
      stack.length = 1;
    }
  });

  return toc;
}

/** 扁平化目录 */
export function flattenTOC(toc: TOCItem[]): TOCItem[] {
  const result: TOCItem[] = [];

  function flatten(items: TOCItem[]) {
    for (const item of items) {
      result.push({ ...item, children: undefined });
      if (item.children) {
        flatten(item.children);
      }
    }
  }

  flatten(toc);
  return result;
}

/** 查找目录项 */
export function findTOCItem(toc: TOCItem[], id: string): TOCItem | null {
  for (const item of toc) {
    if (item.id === id) return item;
    if (item.children) {
      const found = findTOCItem(item.children, id);
      if (found) return found;
    }
  }
  return null;
}
