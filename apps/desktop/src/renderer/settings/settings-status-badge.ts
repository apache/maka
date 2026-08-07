/**
 * Badge tones. Still its own vocabulary because Astryx's Badge has an `info`
 * pill and its own idea of `neutral`, so a Badge can express a shade the dot
 * cannot — mapping it through the status vocabulary would flatten that.
 *
 * Only 一处 still renders these (the subagent settings page). Everything else
 * on the settings surface is a dot plus plain text, per the "no decorative
 * Badge" principle.
 */
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
