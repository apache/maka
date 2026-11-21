/**
 * YouMind Background Service Worker
 *
 * 功能：
 * 1. 上下文菜单管理
 * 2. 消息路由处理
 * 3. 命令快捷键处理
 * 4. 用户状态监听
 */

import { t } from '../i18n';
import { getStoredUser, isUserLoggedIn, onStorageChanged } from '../utils/storage';
import type { ContextMenuItem, CommandName, Message, MessageType } from '../types';

/**
 * 初始化上下文菜单
 */
async function initContextMenus(): Promise<void> {
  // 移除所有现有菜单
  await chrome.contextMenus.removeAll();

  // 检查用户登录状态
  const isLoggedIn = await isUserLoggedIn();
  if (!isLoggedIn) {
    return;
  }

  // 创建保存内容菜单
  chrome.contextMenus.create({
    id: ContextMenuItem.SNIP_CONTENT,
    title: t('Save Content to YouMind'),
    contexts: ['selection'],
  });

  // 创建保存图片菜单
  chrome.contextMenus.create({
    id: ContextMenuItem.SNIP_IMAGE,
    title: t('Save Image to YouMind'),
    contexts: ['image'],
  });

  // 创建保存链接菜单
  chrome.contextMenus.create({
    id: ContextMenuItem.SNIP_LINK,
    title: t('Save Link to YouMind'),
    contexts: ['link'],
  });

  // 获取保存到 YouMind 命令的快捷键
  const shortcut = await getSaveShortcut();

  // 创建保存网页菜单
  chrome.contextMenus.create({
    id: ContextMenuItem.SNIP_WEBPAGE,
    title: shortcut ? `${t('Save Page to YouMind')} (${shortcut})` : t('Save Page to YouMind'),
    contexts: ['page'],
  });
}

/**
 * 获取保存到 YouMind 命令的快捷键
 * @returns 快捷键字符串
 */
async function getSaveShortcut(): Promise<string | undefined> {
  return new Promise((resolve) => {
    chrome.commands.getAll((commands) => {
      const saveCommand = commands.find((cmd) => cmd.name === CommandName.SAVE_TO_YOUMIND);
      resolve(saveCommand?.shortcut);
    });
  });
}

/**
 * 监听上下文菜单点击事件
 */
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) {
    return;
  }

  switch (info.menuItemId) {
    case ContextMenuItem.SNIP_CONTENT:
      await handleSaveContent(tab.id, info.selectionText || '');
      break;
    case ContextMenuItem.SNIP_IMAGE:
      await handleSaveImage(tab.id, info.srcUrl || '');
      break;
    case ContextMenuItem.SNIP_LINK:
      await handleSaveLink(tab.id, info.linkUrl || '');
      break;
    case ContextMenuItem.SNIP_WEBPAGE:
      await handleSaveWebpage(tab.id);
      break;
  }
});

/**
 * 处理保存内容
 * @param tabId 标签页 ID
 * @param selectionText 选中的文本
 */
async function handleSaveContent(tabId: number, selectionText: string): Promise<void> {
  await chrome.tabs.sendMessage(tabId, {
    type: 'SAVE_CONTENT',
    data: { selectionText },
  } as Message);
}

/**
 * 处理保存图片
 * @param tabId 标签页 ID
 * @param srcUrl 图片 URL
 */
async function handleSaveImage(tabId: number, srcUrl: string): Promise<void> {
  await chrome.tabs.sendMessage(tabId, {
    type: 'SAVE_IMAGE',
    data: { imageUrl: srcUrl },
  } as Message);
}

/**
 * 处理保存链接
 * @param tabId 标签页 ID
 * @param linkUrl 链接 URL
 */
async function handleSaveLink(tabId: number, linkUrl: string): Promise<void> {
  await chrome.tabs.sendMessage(tabId, {
    type: 'SAVE_LINK',
    data: { url: linkUrl },
  } as Message);
}

/**
 * 处理保存网页
 * @param tabId 标签页 ID
 */
async function handleSaveWebpage(tabId: number): Promise<void> {
  await chrome.tabs.sendMessage(tabId, {
    type: 'SAVE_WEBPAGE',
  } as Message);
}

/**
 * 监听命令（快捷键）
 */
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (!tab?.id) {
    return;
  }

  switch (command) {
    case CommandName.EXECUTE_ACTION:
    case CommandName.START_CAPTURE:
      // 打开 YouMind 侧边栏或弹窗
      await openYouMind(tab.id);
      break;
    case CommandName.SAVE_TO_YOUMIND:
      await handleSaveWebpage(tab.id);
      break;
    case CommandName.START_TRANSLATE:
      // 开始翻译功能
      await chrome.tabs.sendMessage(tab.id, {
        type: 'START_TRANSLATE',
      } as Message);
      break;
  }
});

/**
 * 打开 YouMind 界面
 * @param tabId 标签页 ID
 */
async function openYouMind(tabId: number): Promise<void> {
  // 可以打开侧边栏或注入内容脚本
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'OPEN_SIDEBAR',
    } as Message);
  } catch (error) {
    console.error('Failed to open YouMind:', error);
  }
}

/**
 * 监听存储变化（用户状态变化时更新菜单）
 */
onStorageChanged((changes, areaName) => {
  if (areaName !== 'local' || !changes.USER_INFO) {
    return;
  }

  const { newValue } = changes.USER_INFO;

  if (!newValue) {
    chrome.contextMenus.removeAll();
    return;
  }

  const userInfo = newValue as { isLogin?: boolean; inWaitlist?: boolean; isInactive?: boolean };

  // 检查用户状态
  if (!userInfo.isLogin || userInfo.inWaitlist || userInfo.isInactive) {
    chrome.contextMenus.removeAll();
  } else {
    initContextMenus();
  }
});

/**
 * 监听安装事件
 */
chrome.runtime.onInstalled.addListener(async () => {
  await initContextMenus();
});

/**
 * 监听启动事件
 */
chrome.runtime.onStartup.addListener(async () => {
  await initContextMenus();
});

/**
 * 消息监听器
 */
chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  // 处理来自 content script 的消息
  (async () => {
    try {
      switch (message.type) {
        case 'GET_USER_INFO':
          const user = await getStoredUser();
          sendResponse({ success: true, data: user });
          break;
        default:
          sendResponse({ success: false, error: 'Unknown message type' });
      }
    } catch (error) {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  })();

  // 返回 true 保持消息通道开启
  return true;
});
