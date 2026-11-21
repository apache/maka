import type { AccountStatus } from '@ggbdpq/console-shared';
import { STATUS_LABELS } from '@ggbdpq/console-shared';
import { Badge } from '@ggbdpq/console-ui';

const VARIANT: Record<AccountStatus, 'success' | 'warning' | 'danger' | 'info' | 'muted' | 'secondary'> = {
  normal: 'success',
  pending_auth: 'muted',
  token_expired: 'warning',
  creds_invalid: 'warning',
  rate_limited: 'info',
  quota_exhausted: 'danger',
  deactivated_k12: 'secondary',
};

export function StatusBadge({ status }: { status: AccountStatus }) {
  return <Badge variant={VARIANT[status] ?? 'muted'}>{STATUS_LABELS[status] ?? status}</Badge>;
}
