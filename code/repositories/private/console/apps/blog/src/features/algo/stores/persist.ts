import { createJSONStorage, type StateStorage } from 'zustand/middleware';

/**
 * 包裹 localStorage 的安全 storage。
 *
 * 无痕模式 getItem/setItem 会抛错、配额满 setItem 会抛错 —— 统一 try/catch 静默降级,
 * 保证应用在受限环境下不崩溃。
 */
export function createSafeJSONStorage() {
  return createJSONStorage((): StateStorage => ({
    getItem: (name) => {
      try {
        return localStorage.getItem(name);
      } catch {
        return null;
      }
    },
    setItem: (name, value) => {
      try {
        localStorage.setItem(name, value);
      } catch {
        /* 配额满或无痕模式:静默忽略 */
      }
    },
    removeItem: (name) => {
      try {
        localStorage.removeItem(name);
      } catch {
        /* 忽略 */
      }
    },
  }));
}
