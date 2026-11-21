/**
 * 认证 —— 不透明随机 token + 内存会话 + 30 分钟滑动过期。
 * 对齐 liliya Go 版 classic 形态（无 Redis）；进程重启即全员下线，属预期行为。
 */
import { randomBytes } from 'node:crypto';

const TTL_MS = 30 * 60 * 1000;

export interface Session {
  userId: number;
  loginName: string;
  userName: string;
  expiresAt: number;
}

const g = globalThis as typeof globalThis & { __adminSessions?: Map<string, Session> };
const sessions = (g.__adminSessions ??= new Map());

export function createSession(userId: number, loginName: string, userName: string): string {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, { userId, loginName, userName, expiresAt: Date.now() + TTL_MS });
  return token;
}

export function getSession(req: Request): Session | null {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    sessions.delete(token);
    return null;
  }
  s.expiresAt = Date.now() + TTL_MS; // 滑动过期
  return s;
}

export function destroySession(req: Request): void {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  sessions.delete(token);
}

export function listSessions(): Array<{ tokenMasked: string; loginName: string; userName: string; expiresAt: number }> {
  const now = Date.now();
  for (const [t, s] of sessions) if (now > s.expiresAt) sessions.delete(t);
  return [...sessions.entries()].map(([t, s]) => ({
    tokenMasked: `${t.slice(0, 8)}…${t.slice(-4)}`,
    loginName: s.loginName,
    userName: s.userName,
    expiresAt: s.expiresAt,
  }));
}

export function killSession(tokenMasked: string): boolean {
  for (const t of sessions.keys()) {
    if (t.startsWith(tokenMasked.split('…')[0])) {
      sessions.delete(t);
      return true;
    }
  }
  return false;
}
