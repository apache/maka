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

/**
 * StatusDot variant for a tone. The settings surface's status language is a
 * dot + plain text ("no decorative Badge" — astryx docs principles); Astryx's
 * StatusDot has no `info` rung, so informational states ride the accent dot.
 */
export function statusDotVariant(tone: StatusTone): 'success' | 'warning' | 'error' | 'accent' | 'neutral' {
  switch (tone) {
    case 'success': return 'success';
    case 'warning': return 'warning';
    case 'destructive': return 'error';
    case 'info': return 'accent';
    case 'neutral': return 'neutral';
  }
}

