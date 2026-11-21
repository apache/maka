/**
 * API 工具函数
 *
 * 提供 YouMind API 和 Jina AI 抓取功能
 */

import type { WebpageContent, UserInfo } from '../types';

/**
 * YouMind API 配置
 */
const YOUMIND_API_ENVS = {
  production: {
    youappHost: 'https://api.youmind.ai',
    youwebHost: 'https://web.youmind.ai',
  },
  development: {
    youappHost: 'http://localhost:3000',
    youwebHost: 'http://localhost:3001',
  },
} as const;

/**
 * 获取 YouMind API 主机
 * @returns API 主机地址
 */
export async function getYouMindHost(): Promise<string> {
  // 从存储中获取配置
  return new Promise((resolve) => {
    chrome.storage.local.get('YOUMIND_ENV', (result) => {
      const env = result.YOUMIND_ENV || 'production';
      resolve(YOUMIND_API_ENVS[env as keyof typeof YOUMIND_API_ENVS]?.youappHost || YOUMIND_API_ENVS.production.youappHost);
    });
  });
}

/**
 * 获取 YouMind Web 主机
 * @returns Web 主机地址
 */
export async function getYouMindWebHost(): Promise<string> {
  return new Promise((resolve) => {
    chrome.storage.local.get('YOUMIND_ENV', (result) => {
      const env = result.YOUMIND_ENV || 'production';
      resolve(YOUMIND_API_ENVS[env as keyof typeof YOUMIND_API_ENVS]?.youwebHost || YOUMIND_API_ENVS.production.youwebHost);
    });
  });
}

/**
 * 使用 Jina AI 抓取网页内容
 * @param url 网页 URL
 * @returns 网页内容
 */
export async function scrapByJina(url: string): Promise<WebpageContent> {
  const jinaApiUrl = `https://r.jina.ai/${url}`;

  const response = await fetch(jinaApiUrl, {
    method: 'GET',
    headers: {
      'Accept': 'text/markdown',
    },
  });

  if (!response.ok) {
    throw new Error(`Jina AI API error: ${response.status} ${response.statusText}`);
  }

  const markdown = await response.text();

  // 解析 Markdown（简化版本，实际可能需要更复杂的解析）
  const lines = markdown.split('\n');
  const title = lines[0]?.replace(/^#+\s*/, '') || '';
  const content = lines.slice(1).join('\n').trim();

  return {
    title,
    content,
    url,
  };
}

/**
 * 上传剪藏到 YouMind
 * @param clip 剪藏数据
 * @param user 用户信息
 * @returns 上传结果
 */
export async function uploadClipToYouMind(
  clip: {
    title: string;
    content?: string;
    url?: string;
    type: string;
    tags?: string[];
  },
  user: UserInfo
): Promise<{ success: boolean; id?: string; error?: string }> {
  const apiHost = await getYouMindHost();

  try {
    const response = await fetch(`${apiHost}/api/clips`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${user.apiKey}`,
      },
      body: JSON.stringify(clip),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    return {
      success: true,
      id: data.id,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * 同步剪藏列表
 * @param user 用户信息
 * @returns 剪藏列表
 */
export async function syncClips(user: UserInfo): Promise<unknown[]> {
  const apiHost = await getYouMindHost();

  const response = await fetch(`${apiHost}/api/clips`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${user.apiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  return response.json();
}

/**
 * 从 HTML 页面提取数据（浏览器环境不可用）
 * @throws Error 浏览器环境不支持此功能
 */
export async function getPageDataFromHTMLWithoutRule(): Promise<never> {
  throw new Error('[stub] getPageDataFromHTMLWithoutRule is not available in browser environment');
}

/**
 * 获取网页标题
 * @returns 网页标题
 */
export function getPageTitle(): string {
  return document.title || '';
}

/**
 * 获取网页 URL
 * @returns 网页 URL
 */
export function getPageUrl(): string {
  return window.location.href;
}

/**
 * 获取选中的文本
 * @returns 选中的文本
 */
export function getSelectionText(): string {
  const selection = window.getSelection();
  return selection?.toString().trim() || '';
}

/**
 * 获取选中的 HTML
 * @returns 选中的 HTML
 */
export function getSelectionHtml(): string {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return '';
  }

  const range = selection.getRangeAt(0);
  const div = document.createElement('div');
  div.appendChild(range.cloneContents());

  return div.innerHTML;
}
