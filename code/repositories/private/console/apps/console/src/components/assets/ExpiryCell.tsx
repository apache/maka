import { daysUntilExpiry } from '@ggbdpq/console-shared';
import { cn } from '@ggbdpq/console-ui';

/** 过期日 + 倒计时，颜色：≥7天绿 / 3–7天黄 / <3天或已过期红 */
export function ExpiryCell({ expiresAt, warnDays = 7 }: { expiresAt: string | null; warnDays?: number }) {
  if (!expiresAt) return <span className="text-muted-foreground">—</span>;
  const days = daysUntilExpiry(expiresAt);
  const datePart = expiresAt.slice(0, 10);
  const color =
    days < 3 ? 'text-destructive' : days < warnDays ? 'text-warning' : 'text-success';
  return (
    <span className={cn('whitespace-nowrap', color)}>
      {datePart}
      <span className="ml-1 text-xs">{days < 0 ? `已过期${-days}天` : `剩${days}天`}</span>
    </span>
  );
}
