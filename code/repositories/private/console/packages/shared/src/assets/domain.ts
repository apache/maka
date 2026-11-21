/**
 * 领域模型与常量 —— 前后端共享
 */

export const ACCOUNT_STATUSES = [
  'normal', // 正常
  'pending_auth', // 待授权
  'token_expired', // token过期(需重授权)
  'creds_invalid', // 凭据失效(需重授权)
  'rate_limited', // 限流(可重试)
  'quota_exhausted', // 额度耗尽
  'deactivated_k12', // 已停用K12(死号)
] as const;

export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export type QuotaHealth = 'healthy' | 'quota_low' | 'quota_exhausted' | 'auth_error' | 'unknown';

export const STATUS_LABELS: Record<AccountStatus, string> = {
  normal: '正常',
  pending_auth: '待授权',
  token_expired: 'token过期',
  creds_invalid: '凭据失效',
  rate_limited: '限流',
  quota_exhausted: '额度耗尽',
  deactivated_k12: '已停用K12',
};

/** 导出 CPA 时默认包含的状态 */
export const DEFAULT_EXPORT_STATUSES: AccountStatus[] = ['normal', 'rate_limited'];

/** 导出时标记 disabled:true 的状态 */
export const DISABLED_IN_EXPORT_STATUSES: AccountStatus[] = [
  'quota_exhausted',
  'token_expired',
  'creds_invalid',
];

export type ExpireRule = 'month' | '30d' | '28d';
export const EXPIRE_RULE_LABELS: Record<ExpireRule, string> = {
  month: '自然月+1',
  '30d': '固定30天',
  '28d': '固定28天',
};

/** 原始 / OA授权 JSONL 一行的账号记录（字段全可选，容忍缺字段） */
export interface RawAccount {
  email: string;
  password?: string;
  phone?: string;
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  session_token?: string;
  client_id?: string;
  chatgpt_account_id?: string;
  account_id?: string;
  chatgpt_user_id?: string;
  organization_id?: string;
  project_id?: string;
  workspace_id?: string;
  platform?: string;
  db_id?: number;
  status?: string;
  source?: string;
  created_at?: number;
  last_used?: number;
  mailapi_url?: string;
  mailbox_url?: string;
  mailbox?: { mailapi_url?: string } | null;
  reauth_at?: string | number;
  reauth_status?: string;
  reauth_source?: string;
  expired?: string | number | boolean;
  last_refresh?: string;
  [k: string]: unknown;
}

export interface AccountRow {
  id: number;
  email: string;
  password: string | null;
  phone: string | null;
  access_token: string | null;
  refresh_token: string | null;
  id_token: string | null;
  account_id: string | null;
  chatgpt_user_id: string | null;
  organization_id: string | null;
  workspace_id: string | null;
  client_id: string | null;
  mailapi_url: string | null;
  platform: string;
  status: AccountStatus;
  quota_percent: number;
  quota_updated_at: string | null;
  quota_source: string | null;
  quota_plan_type: string | null;
  quota_used_percent: number | null;
  quota_reset_at: string | null;
  quota_window_label: string | null;
  quota_window_seconds: number | null;
  quota_limit_reached: number | null;
  quota_allowed: number | null;
  quota_subscription_active_until: string | null;
  quota_reset_credits_available: number | null;
  quota_health: QuotaHealth | null;
  quota_error: string | null;
  quota_snapshot_json: string | null;
  batch_id: number | null;
  duplicate: number;
  reauth_at: string | null;
  reauth_status: string | null;
  reauth_source: string | null;
  expires_at: string | null;
  created_at_src: number | null;
  first_seen_at: string;
  updated_at: string;
}

export interface BatchRow {
  id: number;
  folder_name: string;
  path: string;
  seq: number | null;
  purchase_date: string | null;
  card_code: string | null;
  total_count: number | null;
  total_price: number | null;
  unit_cost: number | null;
  month_group: string | null;
  created_at: string;
}

export interface CpaRecord {
  type: 'codex';
  email: string;
  expired: string;
  id_token: string | null;
  account_id: string | null;
  disabled: boolean;
  access_token: string | null;
  last_refresh: string;
  refresh_token: string | null;
}

export interface ErrorClassification {
  status: AccountStatus;
  reason: string;
}
