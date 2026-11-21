"use client"

import { createStore, type StoreApi } from "zustand/vanilla"
import { useStore } from "zustand"

const tabsKey = "ggbdpq-admin:tabs"
const activeKey = "ggbdpq-admin:active-tab"
const pageStateKey = "ggbdpq-admin:page-state"

export interface AdminTab {
  path: string
  title: string
}

export interface CachedPageState {
  filters?: Record<string, unknown>
  page?: number
  pageSize?: number
  draft?: Record<string, unknown>
  scrollY?: number
}

interface TabState {
  tabs: AdminTab[]
  activePath: string | null
  pageStates: Record<string, CachedPageState>
  openTab: (tab: AdminTab) => void
  closeTab: (path: string) => void
  setActivePath: (path: string) => void
  hydrateFromStorage: () => void
  savePageState: (path: string, state: CachedPageState) => void
  getPageState: (path: string) => CachedPageState | undefined
  clearAll: () => void
}

function storage() {
  if (typeof window === "undefined") return null
  return window.sessionStorage
}

function readJson<T>(key: string, fallback: T): T {
  const value = storage()?.getItem(key)
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function persist(tabs: AdminTab[], activePath: string | null, pageStates: Record<string, CachedPageState>) {
  storage()?.setItem(tabsKey, JSON.stringify(tabs))
  if (activePath) storage()?.setItem(activeKey, activePath)
  else storage()?.removeItem(activeKey)
  storage()?.setItem(pageStateKey, JSON.stringify(pageStates))
}

function createEmptyState() {
  return {
    tabs: [] as AdminTab[],
    activePath: null as string | null,
    pageStates: {} as Record<string, CachedPageState>,
  }
}

function readStorageState() {
  return {
    tabs: readJson<AdminTab[]>(tabsKey, []),
    activePath: storage()?.getItem(activeKey) ?? null,
    pageStates: readJson<Record<string, CachedPageState>>(pageStateKey, {}),
  }
}

export function createTabStore(): StoreApi<TabState> {
  return createStore<TabState>((set, get) => ({
    ...createEmptyState(),
    openTab: (tab) => {
      const current = get()
      const tabs = current.tabs.some((item) => item.path === tab.path) ? current.tabs : [...current.tabs, tab]
      set({ tabs, activePath: tab.path })
      persist(tabs, tab.path, current.pageStates)
    },
    closeTab: (path) => {
      const current = get()
      const tabs = current.tabs.filter((tab) => tab.path !== path)
      const activePath = current.activePath === path ? (tabs.at(-1)?.path ?? null) : current.activePath
      const { [path]: _removed, ...pageStates } = current.pageStates
      set({ tabs, activePath, pageStates })
      persist(tabs, activePath, pageStates)
    },
    setActivePath: (path) => {
      const current = get()
      set({ activePath: path })
      persist(current.tabs, path, current.pageStates)
    },
    hydrateFromStorage: () => {
      set(readStorageState())
    },
    savePageState: (path, state) => {
      const current = get()
      const pageStates = { ...current.pageStates, [path]: state }
      set({ pageStates })
      persist(current.tabs, current.activePath, pageStates)
    },
    getPageState: (path) => get().pageStates[path],
    clearAll: () => {
      set(createEmptyState())
      storage()?.removeItem(tabsKey)
      storage()?.removeItem(activeKey)
      storage()?.removeItem(pageStateKey)
    },
  }))
}

export const tabStore = createTabStore()

export function useTabState<T>(selector: (state: TabState) => T): T {
  return useStore(tabStore, selector)
}
