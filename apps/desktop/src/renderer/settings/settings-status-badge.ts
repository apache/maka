export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'destructive';
export function statusBadgeVariant(tone: StatusTone): 'success' | 'warning' | 'error' | 'info' | 'neutral' {
  switch (tone) {
    case 'success': return 'success';
    case 'warning': return 'warning';
    // Astryx Badge names the destructive status 'error' and the plain pill
    // 'neutral'.
    case 'destructive': return 'error';
    case 'info': return 'info';
    case 'neutral': return 'neutral';
  }
}
