/**
 * 存储工具函数
 *
 * 提供 chrome.storage.local 的封装
 */

import type { UserInfo } from '../types';

/**
 * 存储键枚举
 */
export const StorageKey = {
  /** 用户信息 */
  USER_INFO: 'USER_INFO',
  /** 剪藏列表 */
  CLIPS: 'CLIPS',
  /** 设置 */
  SETTINGS: 'SETTINGS',
  /** AI 配置 */
  AI_CONFIG: 'AI_CONFIG',
} as const;

/**
 * 获取存储的用户信息
 * @returns 用户信息或 undefined
 */
export async function getStoredUser(): Promise<UserInfo | undefined> {
  return new Promise((resolve) => {
    chrome.storage.local.get(StorageKey.USER_INFO, (result) => {
      resolve(result.USER_INFO as UserInfo | undefined);
    });
  });
}

/**
 * 设置用户信息
 * @param userInfo 用户信息
 */
export async function setStoredUser(userInfo: UserInfo): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [StorageKey.USER_INFO]: userInfo }, () => {
      resolve();
    });
  });
}

/**
 * 检查用户是否已登录且有权限
 * @returns 是否已登录且有权限
 */
export async function isUserLoggedIn(): Promise<boolean> {
  const user = await getStoredUser();
  return Boolean(user?.isLogin && !user?.inWaitlist && !user?.isInactive);
}

/**
 * 获取存储数据
 * @param keys 存储键或键数组
 * @returns 存储的数据
 */
export async function getStorage<T>(keys: string | string[]): Promise<T> {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => {
      resolve(result as T);
    });
  });
}

/**
 * 设置存储数据
 * @param data 要存储的数据
 */
export async function setStorage<T extends Record<string, unknown>>(data: T): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set(data, () => {
      resolve();
    });
  });
}

/**
 * 移除存储数据
 * @param keys 存储键或键数组
 */
export async function removeStorage(keys: string | string[]): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.remove(keys, () => {
      resolve();
    });
  });
}

/**
 * 清空所有存储数据
 */
export async function clearStorage(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.clear(() => {
      resolve();
    });
  });
}

/**
 * 监听存储变化
 * @param callback 变化回调函数
 * @returns 监听器移除函数
 */
export function onStorageChanged(
  callback: (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => void
): () => void {
  chrome.storage.onChanged.addListener(callback);

  // 返回移除监听器的函数
  return () => {
    chrome.storage.onChanged.removeListener(callback);
  };
}
