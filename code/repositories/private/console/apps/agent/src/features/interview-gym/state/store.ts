import { create } from "zustand";
import { z } from "zod";
import { createJSONStorage, persist } from "zustand/middleware";
import { attemptSchema } from "@ig/content/types";
import type { Attempt, Scores } from "@ig/content/types";
import { DEFAULT_CONFIG } from "./session";
import type { DaySession, SessionConfig, SessionItem } from "./session";

export type ThemeMode = "dark" | "light" | "system";

// AI 服务商配置：BYOK，Key 只存浏览器 localStorage
export interface ProviderConfig {
  id: string; // uuid
  kind: "openai" | "anthropic"; // openai = OpenAI 兼容协议（DeepSeek/Kimi/智谱/OpenRouter 等）
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  viaProxy: boolean; // CORS 不通的厂商可走本地中继（pnpm proxy）
}

export interface InterviewRecord {
  id: string;
  qid: string;
  ts: number;
  rounds: number;
  providerLabel: string;
  comment: string;
}

interface ArenaState {
  // 练习
  attempts: Attempt[];
  sessions: Record<string, DaySession>;
  config: SessionConfig;
  // 偏好
  theme: ThemeMode;
  interviewRounds: number; // AI 面试官默认追问轮数
  // 收藏与笔记
  bookmarks: Record<string, number>; // qid → 加入时间戳
  notes: Record<string, string>; // qid → 个人笔记
  // AI
  providers: ProviderConfig[];
  defaultProviderId?: string;
  interviewHistory: InterviewRecord[];
  // actions
  ensureSession: (dateKey: string, items: SessionItem[]) => void;
  saveResult: (
    dateKey: string,
    index: number,
    item: SessionItem,
    scores: Scores,
    note: string,
  ) => void;
  recordAttempt: (attempt: Attempt) => void;
  setConfig: (config: SessionConfig) => void;
  setTheme: (theme: ThemeMode) => void;
  setInterviewRounds: (n: number) => void;
  toggleBookmark: (qid: string) => void;
  setNote: (qid: string, text: string) => void;
  upsertProvider: (provider: ProviderConfig) => void;
  removeProvider: (id: string) => void;
  setDefaultProvider: (id: string | undefined) => void;
  addInterviewRecord: (record: InterviewRecord) => void;
  importData: (data: unknown) => void;
  clearAll: () => void;
}

// 兼容缺少可选字段的旧备份；所有提供的字段通过后才进行一次更新。
const backupSchema = z.object({
  attempts: z.array(attemptSchema).optional(),
  config: z.object({
    p0p1: z.number().int().min(0).max(20),
    ai: z.number().int().min(0).max(20),
    design: z.number().int().min(0).max(5),
    project: z.number().int().min(0).max(5),
    retest: z.number().int().min(0).max(10),
  }).optional(),
  bookmarks: z.record(z.string(), z.number().nonnegative()).optional(),
  notes: z.record(z.string(), z.string()).optional(),
  providers: z.array(z.object({
    id: z.string().min(1), kind: z.enum(["openai", "anthropic"]),
    label: z.string(), baseUrl: z.string(), apiKey: z.string(), model: z.string(),
    viaProxy: z.boolean(),
  })).optional(),
  defaultProviderId: z.string().optional(),
  interviewRounds: z.number().int().min(1).max(5).optional(),
});

function emptyProviders(): ProviderConfig[] {
  return [];
}

export const useArena = create<ArenaState>()(
  persist(
    (set) => ({
      attempts: [],
      sessions: {},
      config: DEFAULT_CONFIG,
      theme: "dark",
      interviewRounds: 3,
      bookmarks: {},
      notes: {},
      providers: emptyProviders(),
      defaultProviderId: undefined,
      interviewHistory: [],

      ensureSession: (dateKey, items) =>
        set((state) => {
          if (state.sessions[dateKey]) return state;
          return {
            sessions: { ...state.sessions, [dateKey]: { date: dateKey, items, results: {} } },
          };
        }),

      saveResult: (dateKey, index, item, scores, note) =>
        set((state) => {
          const attempt: Attempt = {
            qid: item.qid,
            date: dateKey,
            ts: Date.now(),
            kind: item.kind,
            scores,
            note,
          };
          const session = state.sessions[dateKey];
          return {
            attempts: [...state.attempts, attempt],
            sessions: session
              ? {
                  ...state.sessions,
                  [dateKey]: { ...session, results: { ...session.results, [index]: attempt } },
                }
              : state.sessions,
          };
        }),

      recordAttempt: (attempt) => set((state) => ({ attempts: [...state.attempts, attempt] })),

      setConfig: (config) => set({ config }),
      setTheme: (theme) => set({ theme }),
      setInterviewRounds: (interviewRounds) => set({ interviewRounds }),

      toggleBookmark: (qid) =>
        set((state) => {
          const next = { ...state.bookmarks };
          if (next[qid]) delete next[qid];
          else next[qid] = Date.now();
          return { bookmarks: next };
        }),

      setNote: (qid, text) => set((state) => ({ notes: { ...state.notes, [qid]: text } })),

      upsertProvider: (provider) =>
        set((state) => {
          const exists = state.providers.some((p) => p.id === provider.id);
          const providers = exists
            ? state.providers.map((p) => (p.id === provider.id ? provider : p))
            : [...state.providers, provider];
          return { providers, defaultProviderId: state.defaultProviderId ?? provider.id };
        }),

      removeProvider: (id) =>
        set((state) => ({
          providers: state.providers.filter((p) => p.id !== id),
          defaultProviderId: state.defaultProviderId === id ? undefined : state.defaultProviderId,
        })),

      setDefaultProvider: (defaultProviderId) => set({ defaultProviderId }),

      addInterviewRecord: (record) =>
        set((state) => ({ interviewHistory: [record, ...state.interviewHistory].slice(0, 20) })),

      importData: (input) => {
        const data = backupSchema.parse(input);
        set((state) => ({
          attempts: data.attempts ?? state.attempts,
          config: data.config ?? state.config,
          bookmarks: data.bookmarks ?? state.bookmarks,
          notes: data.notes ?? state.notes,
          providers: data.providers ?? state.providers,
          defaultProviderId: data.defaultProviderId ?? state.defaultProviderId,
          interviewRounds: data.interviewRounds ?? state.interviewRounds,
        }));
      },

      clearAll: () => set({ attempts: [], sessions: {} }),
    }),
    {
      name: "interview-arena-v2",
      version: 2,
      storage: createJSONStorage(() => localStorage),
      // 回灌时用 Zod 过滤坏数据，避免一条脏记录弄崩全站
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<ArenaState>;
        const attempts = Array.isArray(p.attempts)
          ? p.attempts.filter((a) => attemptSchema.safeParse(a).success)
          : [];
        return {
          ...current,
          attempts,
          sessions: p.sessions ?? {},
          config: { ...DEFAULT_CONFIG, ...p.config },
          theme: p.theme ?? "dark",
          interviewRounds: p.interviewRounds ?? 3,
          bookmarks: p.bookmarks ?? {},
          notes: p.notes ?? {},
          providers: p.providers ?? [],
          defaultProviderId: p.defaultProviderId,
          interviewHistory: p.interviewHistory ?? [],
        };
      },
    },
  ),
);
