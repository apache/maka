// 只存浏览器本地：演示环境没有后端，IndexedDB 是原生能力里最合适的一层。
const DB_NAME = 'ruoyi-ai-web'
const STORE = 'kv'

let dbPromise: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

export async function getState<T>(key: string): Promise<T | null> {
  if (typeof indexedDB === 'undefined') return null
  let db: IDBDatabase
  try {
    db = await open()
  } catch {
    return null // 隐私模式/存储被禁：当作首次启动，内存态照常可用
  }
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
    req.onsuccess = () => resolve((req.result as T | undefined) ?? null)
    req.onerror = () => reject(req.error)
  })
}

export async function setState(key: string, value: unknown): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  let db: IDBDatabase
  try {
    db = await open()
  } catch {
    return
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
