"use client"

import { createStore, type StoreApi } from "zustand/vanilla"
import { useStore } from "zustand"
import type { AdminUser, MenuItem } from "@/features/admin/schemas"

const tokenKey = "ggbdpq-admin:token"
const userKey = "ggbdpq-admin:user"
const menusKey = "ggbdpq-admin:menus"

export type AdminSession = {
  accessToken: string
  user: AdminUser
  menus: MenuItem[]
}

interface AuthState {
  accessToken: string | null
  user: AdminUser | null
  menus: MenuItem[]
  hydrated: boolean
  setSession: (session: AdminSession) => void
  hydrateFromStorage: () => void
  clearSession: () => void
  hasPermission: (permission: string) => boolean
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

function createEmptyState() {
  return {
    accessToken: null as string | null,
    user: null as AdminUser | null,
    menus: [] as MenuItem[],
    hydrated: false,
  }
}

function readStorageState() {
  return {
    accessToken: storage()?.getItem(tokenKey) ?? null,
    user: readJson<AdminUser | null>(userKey, null),
    menus: readJson<MenuItem[]>(menusKey, []),
    hydrated: true,
  }
}

export function createAuthStore(): StoreApi<AuthState> {
  return createStore<AuthState>((set, get) => ({
    ...createEmptyState(),
    setSession: (session) => {
      storage()?.setItem(tokenKey, session.accessToken)
      storage()?.setItem(userKey, JSON.stringify(session.user))
      storage()?.setItem(menusKey, JSON.stringify(session.menus))
      set({
        accessToken: session.accessToken,
        user: session.user,
        menus: session.menus,
        hydrated: true,
      })
    },
    hydrateFromStorage: () => {
      set(readStorageState())
    },
    clearSession: () => {
      storage()?.removeItem(tokenKey)
      storage()?.removeItem(userKey)
      storage()?.removeItem(menusKey)
      set({
        accessToken: null,
        user: null,
        menus: [],
        hydrated: true,
      })
    },
    hasPermission: (permission) => {
      return get().user?.permissions.includes(permission) ?? false
    },
  }))
}

export const authStore = createAuthStore()

export function useAuthState<T>(selector: (state: AuthState) => T): T {
  return useStore(authStore, selector)
}
