"use client";
import { create } from "zustand";
import { persist } from "zustand/middleware";

// 演示双人切换：Web 无微信 openId，用两个演示身份承载 couple 双方逻辑

export const DEMO_USERS = [
  { id: "user-a", name: "阿关" },
  { id: "user-b", name: "秀秀" },
];

interface DatePlaybookSessionState {
  currentUserId: string;
  coupleId: string | null;
  setUser: (id: string) => void;
  setCouple: (id: string | null) => void;
}

export const useDatePlaybookSession = create<DatePlaybookSessionState>()(
  persist(
    (set) => ({
      currentUserId: "user-a",
      coupleId: null,
      setUser: (currentUserId) => set({ currentUserId }),
      setCouple: (coupleId) => set({ coupleId }),
    }),
    { name: "blog-date-playbook-session" },
  ),
);
