/**
 * API 客户端 + TanStack Query hooks
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccountRow, AccountStatus, BatchRow } from '@ggbdpq/console-shared';

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `请求失败 ${res.status}`);
  return data as T;
}

export interface Settings {
  expire_rule: 'month' | '30d' | '28d';
  warn_days: number;
  card_root: string;
  scan_roots: {
    purchase_root: string;
    cli_proxy_root: string;
  };
  statuses: AccountStatus[];
  default_export_statuses: AccountStatus[];
}

export interface Overview {
  byStatus: Array<{ status: AccountStatus; c: number }>;
  expiring: Array<{ id: number; email: string; status: AccountStatus; expires_at: string }>;
  recentReauth: Array<{ id: number; email: string; reauth_at: string; expires_at: string }>;
  total: number;
  alive: number;
}

export type BatchWithStats = BatchRow & { alive: number | null; total: number };

export const useSettings = () => useQuery({ queryKey: ['settings'], queryFn: () => req<Settings>('/api/assets/settings') });
export const useOverview = () => useQuery({ queryKey: ['overview'], queryFn: () => req<Overview>('/api/assets/overview') });
export const useBatches = () => useQuery({ queryKey: ['batches'], queryFn: () => req<BatchWithStats[]>('/api/assets/batches') });

export interface AccountsQuery {
  batchId?: number;
  status?: string;
  email?: string;
  expiring?: number;
  limit?: number;
  offset?: number;
}

export const useAccounts = (q: AccountsQuery) =>
  useQuery({
    queryKey: ['accounts', q],
    queryFn: () => {
      const params = new URLSearchParams();
      if (q.batchId) params.set('batchId', String(q.batchId));
      if (q.status) params.set('status', q.status);
      if (q.email) params.set('email', q.email);
      if (q.expiring) params.set('expiring', String(q.expiring));
      if (q.limit) params.set('limit', String(q.limit));
      if (q.offset) params.set('offset', String(q.offset));
      return req<{ rows: AccountRow[]; total: number }>(`/api/accounts?${params}`);
    },
  });

export interface StatusHistoryRow {
  id: number;
  from_status: string | null;
  to_status: string;
  reason: string | null;
  created_at: string;
}
export interface QuotaHistoryRow {
  id: number;
  from_quota: number | null;
  to_quota: number;
  reason: string | null;
  created_at: string;
}

export const useAccountDetail = (id: number | null) =>
  useQuery({
    queryKey: ['account', id],
    enabled: id !== null,
    queryFn: () =>
      req<{ account: AccountRow; history: { status: StatusHistoryRow[]; quota: QuotaHistoryRow[] } }>(
        `/api/accounts/${id}`,
      ),
  });

function useInvalidatingMutation<TBody, TRes>(fn: (body: TBody) => Promise<TRes>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries();
    },
  });
}

export const useScan = () =>
  useInvalidatingMutation((body?: { reset?: boolean; root?: string; saveDefault?: boolean }) =>
    req<{
      batchesFound: number;
      filesRead: number;
      original: { created: number; updated: number };
      reauth: { applied: number; unmatched: string[] };
      errors: string[];
    }>('/api/assets/scan', { method: 'POST', body: JSON.stringify(body ?? {}) }),
  );

export const useDeleteAccount = () =>
  useInvalidatingMutation((id: number) =>
    req<{ deleted: number }>(`/api/accounts/${id}`, { method: 'DELETE' }),
  );

export const useDeleteAccounts = () =>
  useInvalidatingMutation((ids: number[]) =>
    req<{ deleted: number }>('/api/assets/accounts', { method: 'DELETE', body: JSON.stringify({ ids }) }),
  );

export interface QuotaRefreshResult {
  id: number;
  account: AccountRow | null;
  snapshot?: unknown;
  error?: string;
}

export const useRefreshAccountQuota = () =>
  useInvalidatingMutation((id: number) =>
    req<QuotaRefreshResult>(`/api/accounts/${id}/quota/refresh`, { method: 'POST' }),
  );

export const useRefreshAccountsQuota = () =>
  useInvalidatingMutation((ids: number[]) =>
    req<{ refreshed: number; failed: number; results: QuotaRefreshResult[] }>('/api/assets/accounts/quota/refresh', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  );

export const useImportOriginal = () =>
  useInvalidatingMutation((body: { text: string; batchId?: number; fileName?: string }) =>
    req<{ parsed: number; created: number; updated: number }>('/api/assets/import/original', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );

export const useImportReauth = () =>
  useInvalidatingMutation((body: { text: string; fileName?: string }) =>
    req<{ parsed: number; applied: number; unmatched: string[] }>('/api/assets/import/reauth', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );

export const useImportErrors = () =>
  useInvalidatingMutation((body: { text: string; accountIds?: number[] }) =>
    req<{ applied: number; unmatched: string[]; unrecognized: number; lines: number }>(
      '/api/assets/import/errors',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  );

export const usePatchAccount = () =>
  useInvalidatingMutation(
    (body: { id: number; quota_percent?: number; status?: AccountStatus; reason?: string }) =>
      req<AccountRow>(`/api/accounts/${body.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
  );

export const useExportCpa = () =>
  useMutation({
    mutationFn: (body: { batchIds?: number[]; statuses?: AccountStatus[] }) =>
      req<{ fileName: string; count: number }>('/api/assets/export/cpa', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });

export const downloadUrl = (fileName: string) => `/api/export/download/${encodeURIComponent(fileName)}`;
