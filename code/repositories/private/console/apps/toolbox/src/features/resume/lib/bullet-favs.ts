"use client"

// 范例收藏夹（R 路线图）：收藏的范例 id 持久化，对话框内可筛选。

import { create } from "zustand"
import { persist } from "zustand/middleware"

interface FavState {
  ids: string[]
  toggle: (id: string) => void
}

export const useBulletFavs = create<FavState>()(
  persist(
    (set) => ({
      ids: [],
      toggle: (id) =>
        set((s) => ({
          ids: s.ids.includes(id) ? s.ids.filter((x) => x !== id) : [...s.ids, id],
        })),
    }),
    { name: "resume-bullet-favs" },
  ),
)
