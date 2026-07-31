export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'destructive';
export function statusBadgeVariant(tone: StatusTone): 'success' | 'warning' | 'error' | 'info' | 'neutral' {
  switch (tone) {
    case 'success': return 'success';
    case 'warning': return 'warning';
    // Astryx Badge (#1565 PR 3) names the destructive status 'error' and the
    // plain pill 'neutral'.
    case 'destructive': return 'error';
    case 'info': return 'info';
    case 'neutral': return 'neutral';
  }
}

// Toggle controls are Astryx-owned through the @maka/ui barrel (#1565 PR 4).
