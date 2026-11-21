/** 把时间戳格式化为中文相对时间 */
export function formatRelativeTime(iso: string, now = Date.now()): string {
  const diff = now - new Date(iso).getTime();
  if (Number.isNaN(diff)) return "未知时间";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.floor(months / 12)} 年前`;
}

/** 大数字缩写：1234 -> 1.2k */
export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

/** 从用户名生成头像缩写（中文取末两字，英文取首字母） */
export function avatarInitials(name: string): string {
  if (!name) return "?";
  if (/[一-龥]/.test(name)) return name.slice(-2);
  const parts = name.split(/[\s_-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

/** 信任等级名称 */
export const TRUST_LEVELS = ["游客", "新会员", "会员", "常客", "核心成员"] as const;

export function trustLevelName(level: number): string {
  return TRUST_LEVELS[Math.min(Math.max(level, 0), 4)];
}
