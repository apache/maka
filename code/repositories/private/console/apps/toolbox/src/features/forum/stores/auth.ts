import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { User } from "@/features/forum/schemas/forum";

interface AuthState {
  currentUser: User | null;
  login: (username: string) => void;
  logout: () => void;
}

const COLORS = ["#2563eb", "#dc2626", "#059669", "#7c3aed", "#ea580c", "#0891b2", "#db2777"];

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      currentUser: null,
      login: (username) => {
        const trimmed = username.trim();
        if (!trimmed) return;
        const color = COLORS[trimmed.length % COLORS.length];
        set({
          currentUser: {
            id: `local-${trimmed}`,
            username: trimmed,
            nickname: trimmed,
            title: "新注册会员",
            trustLevel: 0,
            postCount: 0,
            joinedAt: new Date().toISOString(),
            isAdmin: false,
            color,
          },
        });
      },
      logout: () => set({ currentUser: null }),
    }),
    { name: "ggbdpq-forum-auth" },
  ),
);
