"use client"

import { create } from "zustand"
import { persist } from "zustand/middleware"
import type { AdminLocale } from "@/features/admin/schemas"

interface LocaleState {
  locale: AdminLocale
  setLocale: (locale: AdminLocale) => void
}

export const useAdminLocale = create<LocaleState>()(
  persist(
    (set) => ({
      locale: "zh-CN",
      setLocale: (locale) => set({ locale }),
    }),
    { name: "ggbdpq-admin:locale:v1" },
  ),
)
