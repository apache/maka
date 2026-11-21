import { STATUS_LABELS, type AccountRow, type AccountStatus } from '@ggbdpq/console-shared';

export type QuotaTone = 'healthy' | 'low' | 'blocked' | 'stale' | 'unknown';

export interface QuotaPresentation {
  label: string;
  meta: string;
  percent: number | null;
  tone: QuotaTone;
}

export function getQuotaPresentation(account: Pick<
  AccountRow,
  'quota_source' | 'quota_percent' | 'quota_used_percent' | 'quota_health' | 'quota_window_label' | 'quota_reset_at' | 'quota_error'
>): QuotaPresentation {
  if (!account.quota_source) {
    return {
      label: '未刷新',
      meta: '未调用真实额度接口',
      percent: null,
      tone: account.quota_error ? 'unknown' : 'stale',
    };
  }

  const percent = Math.max(0, Math.min(100, account.quota_percent));
  const tone: QuotaTone =
    account.quota_health === 'quota_exhausted'
      ? 'blocked'
      : account.quota_health === 'quota_low' || percent <= 20
        ? 'low'
        : account.quota_health === 'unknown'
          ? 'unknown'
          : 'healthy';
  const parts = [
    account.quota_window_label,
    account.quota_used_percent == null ? null : `已用 ${account.quota_used_percent}%`,
    account.quota_reset_at ? `重置 ${account.quota_reset_at.slice(0, 16).replace('T', ' ')}` : null,
  ].filter(Boolean);

  return {
    label: `可用 ${percent}%`,
    meta: parts.join(' · ') || '真实额度已刷新',
    percent,
    tone,
  };
}

export type OperationsSeverity = 'danger' | 'warning' | 'info' | 'muted';

export interface OperationsSummary {
  healthRate: number;
  needsAttention: number;
  riskQueue: Array<{
    status: AccountStatus;
    label: string;
    count: number;
    severity: OperationsSeverity;
  }>;
}

const RISK_ORDER: Array<{ status: AccountStatus; severity: OperationsSeverity }> = [
  { status: 'quota_exhausted', severity: 'danger' },
  { status: 'token_expired', severity: 'danger' },
  { status: 'creds_invalid', severity: 'warning' },
  { status: 'rate_limited', severity: 'warning' },
  { status: 'pending_auth', severity: 'info' },
  { status: 'deactivated_k12', severity: 'muted' },
];

export function buildOperationsSummary(input: {
  byStatus: Array<{ status: AccountStatus; c: number }>;
  total: number;
  alive: number;
  expiringCount: number;
}): OperationsSummary {
  const countOf = (status: AccountStatus) => input.byStatus.find((item) => item.status === status)?.c ?? 0;
  const riskQueue = RISK_ORDER.map(({ status, severity }) => ({
    status,
    label: STATUS_LABELS[status],
    count: countOf(status),
    severity,
  })).filter((item) => item.count > 0);
  const riskyAccounts = riskQueue
    .filter((item) => item.status !== 'deactivated_k12')
    .reduce((sum, item) => sum + item.count, 0);
  const needsAttention = riskyAccounts + input.expiringCount;
  const healthRate = input.total > 0 ? Math.round((input.alive / input.total) * 100) : 100;

  return {
    healthRate,
    needsAttention,
    riskQueue,
  };
}
