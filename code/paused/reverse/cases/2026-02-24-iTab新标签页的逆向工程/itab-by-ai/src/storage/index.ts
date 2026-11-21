/**
 * 存储层统一导出
 */

export { default as indexdb, IndexedDBWrapper } from './indexdb'
export { default as localStorage, LocalStorageWrapper } from './localStorage'
export { default as chromeStorage, ChromeStorageWrapper } from './chromeStorage'
export * from '../types/storage'
