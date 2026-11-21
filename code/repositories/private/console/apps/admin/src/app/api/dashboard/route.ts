import { db } from '@/server/db';
import { guard, ok } from '@/server/api-utils';
import { listSessions } from '@/server/auth';

export const runtime = 'nodejs';

/** 仪表盘（登录即可，对齐 Go 版 dashboard/stats+trends 无 RequirePerm）。 */
export async function GET(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const stats = {
    users: (db.prepare("SELECT COUNT(*) AS n FROM sys_user WHERE del_flag = '0'").get() as { n: number }).n,
    roles: (db.prepare("SELECT COUNT(*) AS n FROM sys_role WHERE del_flag = '0'").get() as { n: number }).n,
    online: listSessions().length,
    loginsToday: (db.prepare("SELECT COUNT(*) AS n FROM sys_logininfor WHERE login_time >= date('now','localtime')").get() as { n: number }).n,
  };
  // 最近 7 天登录趋势（按日聚合成功+失败）
  const trends = db.prepare(
    `SELECT date(login_time) AS d, COUNT(*) AS n FROM sys_logininfor
     WHERE login_time >= date('now','localtime','-6 days') GROUP BY date(login_time) ORDER BY d`,
  ).all() as Array<{ d: string; n: number }>;
  const byDate = new Map(trends.map((t) => [t.d, t.n]));
  const series = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.now() - (6 - i) * 86400000).toISOString().slice(0, 10);
    return { date: d, count: byDate.get(d) ?? 0 };
  });
  const recent = db.prepare('SELECT user_name, ipaddr, status, msg, login_time FROM sys_logininfor ORDER BY info_id DESC LIMIT 6').all();
  return ok({ stats, trends: series, recent });
}
