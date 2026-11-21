import { useEffect } from "react";
import { useContent } from "@ig/content/useContent";
import { localDateKey } from "@ig/lib/dates";
import { useArena } from "./store";
import { buildDailyItems } from "./session";
import type { DaySession } from "./session";

// 当天会话不存在则按配比生成一次；之后读写都走 store 里持久化的那份
export function useTodaySession(): DaySession | undefined {
  const content = useContent();
  const attempts = useArena((s) => s.attempts);
  const config = useArena((s) => s.config);
  const sessions = useArena((s) => s.sessions);
  const ensureSession = useArena((s) => s.ensureSession);

  const dateKey = localDateKey();
  useEffect(() => {
    if (!sessions[dateKey]) {
      ensureSession(
        dateKey,
        buildDailyItems(content.bank, content.projectCards, attempts, dateKey, config),
      );
    }
  }, [dateKey, sessions, ensureSession, content, attempts, config]);

  return sessions[dateKey];
}
