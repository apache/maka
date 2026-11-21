import { useEffect, useMemo, useState } from 'react';
import { Copy, RotateCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ACCOUNT_STATUSES, STATUS_LABELS, type AccountStatus } from '@ggbdpq/console-shared';
import { useAccountDetail, useDeleteAccount, usePatchAccount, useRefreshAccountQuota } from '@/lib/assets/api';
import { StatusBadge } from '@/components/assets/StatusBadge';
import { ExpiryCell } from '@/components/assets/ExpiryCell';
import { ActionErrorDialog, type ActionErrorState } from '@/components/assets/ActionErrorDialog';
import { getQuotaPresentation, type QuotaTone } from '@/lib/assets/accountPresentation';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, cn } from '@ggbdpq/console-ui';
import { Button } from '@ggbdpq/console-ui';
import { Input } from '@ggbdpq/console-ui';
import { Label } from '@ggbdpq/console-ui';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@ggbdpq/console-ui';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ggbdpq/console-ui';

const QUOTA_TONE_TEXT: Record<QuotaTone, string> = {
  healthy: 'text-success',
  low: 'text-warning',
  blocked: 'text-destructive',
  stale: 'text-muted-foreground',
  unknown: 'text-muted-foreground/75',
};

const QUOTA_TONE_BAR: Record<QuotaTone, string> = {
  healthy: 'bg-success',
  low: 'bg-warning',
  blocked: 'bg-destructive',
  stale: 'bg-muted-foreground/35',
  unknown: 'bg-muted-foreground/60',
};

function copy(text: string | null, what: string) {
  if (!text) return;
  void navigator.clipboard.writeText(text).then(() => toast.success(`${what} 已复制`));
}

const QUOTA_HEALTH_LABELS: Record<string, string> = {
  healthy: '健康',
  quota_low: '额度偏低',
  quota_exhausted: '额度耗尽',
  auth_error: '鉴权异常',
  unknown: '未知',
};

function fmtTime(value: string | null | undefined): string {
  return value ? value.slice(0, 19).replace('T', ' ') : '—';
}

function boolText(value: number | null | undefined): string {
  if (value === 1) return '是';
  if (value === 0) return '否';
  return '—';
}

function valueText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 80)}…` : value;
  return JSON.stringify(value);
}

function parseQuotaSnapshot(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function snapshotWindows(snapshot: Record<string, unknown> | null): Array<Record<string, unknown>> {
  const windows = snapshot?.windows;
  return Array.isArray(windows) ? windows.filter((w): w is Record<string, unknown> => Boolean(w) && typeof w === 'object') : [];
}

const FIELD_SECTIONS = [
  {
    title: '账号基础字段',
    rows: [
      ['id', 'number', '只读，自增主键'],
      ['email', 'string', '唯一邮箱，列表查询和删除的主要识别字段'],
      ['phone/password/mailapi_url', 'string/null', '来自卡密文件；凭据页展示和复制'],
      ['platform', 'string', '默认 chatgpt，来自导入文件'],
      ['batch_id', 'number/null', '购买批次归属，扫描购买目录时以批次为准'],
      ['duplicate', '0/1', '同邮箱跨批次时标记重复'],
    ],
  },
  {
    title: '状态与授权字段',
    rows: [
      ['status', ACCOUNT_STATUSES.join(' / '), '可手动修改；真实额度耗尽/401 会联动部分状态'],
      ['reauth_at', 'ISO/null', '最近一次 OA/CLIProxy 授权时间'],
      ['reauth_status', 'string/null', '授权结果，例如 success'],
      ['reauth_source', 'string/null', '授权来源，例如 oa'],
      ['expires_at', 'ISO/null', '按过期规则计算的账号到期时间'],
      ['first_seen_at/updated_at', 'ISO', '首次入库和最近更新时间'],
    ],
  },
  {
    title: '真实额度字段',
    rows: [
      ['quota_source', 'openai_wham/null', '刷新成功后写入；为空表示未拿到真实额度'],
      ['quota_percent', '0–100 integer', '当前最紧窗口的可用百分比；手工值不等于真实值'],
      ['quota_used_percent', '0–100/null', 'OpenAI 返回的已用百分比'],
      ['quota_window_label', 'string/null', '5 小时限额、周限额、月度限额等'],
      ['quota_reset_at', 'ISO/null', '接口 reset_at 或 reset_after_seconds 推导出的重置时间'],
      ['quota_window_seconds', 'number/null', '额度窗口秒数，例如 18000、604800、约 2592000'],
      ['quota_limit_reached/quota_allowed', '0/1/null', '是否触顶、接口是否允许继续使用'],
      ['quota_subscription_active_until', 'ISO/null', '订阅/充值到期字段，接口有值才展示'],
      ['quota_reset_credits_available', 'number/null', '主动重置次数'],
      ['quota_health', 'healthy / quota_low / quota_exhausted / auth_error / unknown', '账号健康度归一化结果'],
      ['quota_error', 'string/null', '最近一次额度刷新失败原因'],
      ['quota_snapshot_json', 'JSON/null', '刷新成功时保存的归一化快照和原始响应摘要'],
    ],
  },
] as const;

export function AccountDetailDialog({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { data, isLoading, error: detailError } = useAccountDetail(id);
  const patch = usePatchAccount();
  const deleteAccount = useDeleteAccount();
  const refreshQuota = useRefreshAccountQuota();
  const [quota, setQuota] = useState('');
  const [actionError, setActionError] = useState<ActionErrorState | null>(null);

  const acc = data?.account;
  const quotaSnapshot = useMemo(() => parseQuotaSnapshot(acc?.quota_snapshot_json ?? null), [acc?.quota_snapshot_json]);
  const windows = useMemo(() => snapshotWindows(quotaSnapshot), [quotaSnapshot]);
  const quotaInfo = acc ? getQuotaPresentation(acc) : null;

  useEffect(() => {
    if (!detailError) return;
    setActionError({
      title: '详情接口错误',
      message: '账号详情加载失败',
      detail: detailError.message,
    });
  }, [detailError]);

  return (
    <>
      <Dialog open={id !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-6xl gap-0 p-0">
        <div className="border-b bg-card px-6 py-5">
          <DialogHeader className="pr-10">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <DialogTitle className="truncate font-mono text-lg">{acc?.email ?? '加载中…'}</DialogTitle>
                <DialogDescription className="mt-2">
                  {acc && (
                    <span className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={acc.status} />
                      <span>过期 <ExpiryCell expiresAt={acc.expires_at} /></span>
                      <span>平台：{acc.platform}</span>
                    </span>
                  )}
                </DialogDescription>
              </div>
              {acc && quotaInfo && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    disabled={refreshQuota.isPending || !acc.access_token}
                    onClick={() =>
                      refreshQuota.mutate(acc.id, {
                        onSuccess: (r) => {
                          if (r.error) {
                            setActionError({
                              title: '刷新额度失败',
                              message: `${acc.email} 的真实额度刷新失败`,
                              detail: r.error,
                            });
                          } else {
                            toast.success('真实额度已刷新');
                          }
                        },
                        onError: (e) =>
                          setActionError({
                            title: '刷新额度接口错误',
                            message: `${acc.email} 的真实额度刷新请求失败`,
                            detail: e.message,
                          }),
                      })
                    }
                  >
                    <RotateCw className={refreshQuota.isPending ? 'animate-spin' : undefined} />
                    {refreshQuota.isPending ? '刷新中…' : '刷新额度'}
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={deleteAccount.isPending}
                    onClick={() => {
                      if (!window.confirm(`确定删除账号 ${acc.email} 吗？`)) return;
                      deleteAccount.mutate(acc.id, {
                        onSuccess: () => {
                          toast.success('账号已删除');
                          onClose();
                        },
                        onError: (e) =>
                          setActionError({
                            title: '删除账号失败',
                            message: `${acc.email} 删除失败`,
                            detail: e.message,
                          }),
                      });
                    }}
                  >
                    <Trash2 />
                    删除
                  </Button>
                </div>
              )}
            </div>
          </DialogHeader>
          {acc && quotaInfo && (
            <div className="mt-4 grid gap-3 md:grid-cols-4">
              <div className="rounded-2xl border bg-background/70 p-3">
                <div className="text-xs text-muted-foreground">真实额度</div>
                <div className={cn('mt-1 text-2xl font-semibold', QUOTA_TONE_TEXT[quotaInfo.tone])}>{quotaInfo.label}</div>
                <div className="mt-2 h-1.5 rounded-full bg-muted">
                  <div className={cn('h-full rounded-full', QUOTA_TONE_BAR[quotaInfo.tone])} style={{ width: `${quotaInfo.percent ?? 0}%` }} />
                </div>
              </div>
              <div className="rounded-2xl border bg-background/70 p-3">
                <div className="text-xs text-muted-foreground">健康度</div>
                <div className="mt-1 text-lg font-semibold">{acc.quota_health ? (QUOTA_HEALTH_LABELS[acc.quota_health] ?? acc.quota_health) : '未判断'}</div>
                <div className="mt-1 line-clamp-1 text-xs text-muted-foreground">{quotaInfo.meta}</div>
              </div>
              <div className="rounded-2xl border bg-background/70 p-3">
                <div className="text-xs text-muted-foreground">限额重置</div>
                <div className="mt-1 text-sm font-medium">{fmtTime(acc.quota_reset_at)}</div>
                <div className="mt-1 text-xs text-muted-foreground">{acc.quota_window_label ?? '暂无窗口'}</div>
              </div>
              <div className="rounded-2xl border bg-background/70 p-3">
                <div className="text-xs text-muted-foreground">订阅/充值到期</div>
                <div className="mt-1 text-sm font-medium">{fmtTime(acc.quota_subscription_active_until)}</div>
                <div className="mt-1 text-xs text-muted-foreground">主动重置 {acc.quota_reset_credits_available ?? '—'} 次</div>
              </div>
            </div>
          )}
        </div>
        {isLoading && <div className="py-8 text-center text-muted-foreground">加载中…</div>}
        {acc && (
          <Tabs defaultValue="info" className="p-6">
            <TabsList className="mb-4">
              <TabsTrigger value="info">信息与操作</TabsTrigger>
              <TabsTrigger value="history">流水记录</TabsTrigger>
              <TabsTrigger value="fields">字段与快照</TabsTrigger>
              <TabsTrigger value="tokens">凭据</TabsTrigger>
            </TabsList>

            <TabsContent value="info" className="space-y-4">
              <div className="rounded-2xl border bg-background/70 p-4 text-sm">
                <div>
                  <div className="font-medium">OpenAI 真实额度诊断</div>
                  <div className="mt-1 text-muted-foreground">
                    {acc.quota_source
                      ? `可用 ${acc.quota_percent}% / 已用 ${acc.quota_used_percent ?? '—'}%`
                      : '未调用 wham/usage 刷新，当前不展示静态额度作为真实值'}
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-2 text-muted-foreground">
                  <div>计划：{acc.quota_plan_type ?? '—'}</div>
                  <div>健康度：{acc.quota_health ? (QUOTA_HEALTH_LABELS[acc.quota_health] ?? acc.quota_health) : '—'}</div>
                  <div>额度窗口：{acc.quota_window_label ?? '—'}</div>
                  <div>限额重置：{fmtTime(acc.quota_reset_at)}</div>
                  <div>订阅/充值到期：{fmtTime(acc.quota_subscription_active_until)}</div>
                  <div>主动重置次数：{acc.quota_reset_credits_available ?? '—'}</div>
                  <div>触顶：{boolText(acc.quota_limit_reached)}</div>
                  <div>允许继续：{boolText(acc.quota_allowed)}</div>
                  <div>最近检查：{fmtTime(acc.quota_updated_at)}</div>
                  <div>Account ID：{acc.account_id ?? '—'}</div>
                </div>
                {acc.quota_error && <div className="mt-2 text-xs text-destructive">刷新错误：{acc.quota_error}</div>}
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>最近授权：{acc.reauth_at?.slice(0, 19) ?? '—'}</div>
                <div>授权来源：{acc.reauth_source ?? '—'}</div>
                <div>账号ID：{acc.account_id ?? '—'}</div>
                <div>平台：{acc.platform}</div>
              </div>
              <div className="flex items-end gap-2">
                <div className="space-y-1">
                  <Label>设置额度（0–100）</Label>
                  <Input
                    className="w-28"
                    type="number"
                    min={0}
                    max={100}
                    placeholder={String(acc.quota_percent)}
                    value={quota}
                    onChange={(e) => setQuota(e.target.value)}
                  />
                </div>
                <Button
                  onClick={() => {
                    const q = parseInt(quota, 10);
                    if (Number.isNaN(q)) return toast.error('请输入数字');
                    patch.mutate(
                        { id: acc.id, quota_percent: q },
                        {
                          onSuccess: () => toast.success(`额度已设为 ${q}%`),
                          onError: (e) =>
                            setActionError({
                              title: '保存额度失败',
                              message: `${acc.email} 手动额度保存失败`,
                              detail: e.message,
                            }),
                        },
                      );
                  }}
                  disabled={patch.isPending}
                >
                  保存额度
                </Button>
              </div>
              <div className="space-y-1">
                <Label>手动改状态</Label>
                <div className="flex gap-2">
                  <Select
                    value={acc.status}
                    onValueChange={(v) =>
                      patch.mutate(
                        { id: acc.id, status: v as AccountStatus },
                        {
                          onSuccess: () => toast.success('状态已更新'),
                          onError: (e) =>
                            setActionError({
                              title: '状态更新失败',
                              message: `${acc.email} 状态更新失败`,
                              detail: e.message,
                            }),
                        },
                      )
                    }
                  >
                    <SelectTrigger className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ACCOUNT_STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {STATUS_LABELS[s]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="destructive"
                    onClick={() =>
                      patch.mutate(
                        { id: acc.id, status: 'deactivated_k12', reason: '手动标记K12' },
                        {
                          onSuccess: () => toast.success('已标记 K12'),
                          onError: (e) =>
                            setActionError({
                              title: '标记 K12 失败',
                              message: `${acc.email} 标记 K12 失败`,
                              detail: e.message,
                            }),
                        },
                      )
                    }
                  >
                    标记 K12
                  </Button>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="history" className="space-y-4 text-sm">
              <div>
                <div className="mb-1 font-medium">状态流水</div>
                <ul className="space-y-1 text-muted-foreground">
                  {data?.history.status.map((h) => (
                    <li key={h.id}>
                      {h.created_at.slice(0, 19)}：{h.from_status ?? '—'} → {h.to_status}（{h.reason ?? ''}）
                    </li>
                  ))}
                  {data?.history.status.length === 0 && <li>暂无</li>}
                </ul>
              </div>
              <div>
                <div className="mb-1 font-medium">额度流水</div>
                <ul className="space-y-1 text-muted-foreground">
                  {data?.history.quota.map((h) => (
                    <li key={h.id}>
                      {h.created_at.slice(0, 19)}：{h.from_quota ?? '—'}% → {h.to_quota}%（{h.reason ?? ''}）
                    </li>
                  ))}
                  {data?.history.quota.length === 0 && <li>暂无</li>}
                </ul>
              </div>
            </TabsContent>

            <TabsContent value="fields" className="space-y-4 text-sm">
              <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
                <div className="space-y-3">
                  {FIELD_SECTIONS.map((section) => (
                    <div key={section.title} className="rounded-md border p-3">
                      <div className="mb-2 font-medium">{section.title}</div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs">
                          <thead className="text-muted-foreground">
                            <tr>
                              <th className="w-52 py-1">字段</th>
                              <th className="w-56 py-1">取值/类型</th>
                              <th className="py-1">限制说明</th>
                            </tr>
                          </thead>
                          <tbody>
                            {section.rows.map(([field, valueRange, rule]) => (
                              <tr key={field} className="border-t">
                                <td className="py-1.5 font-mono">{field}</td>
                                <td className="py-1.5 text-muted-foreground">{valueRange}</td>
                                <td className="py-1.5">{rule}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="space-y-3">
                  <div className="rounded-md border p-3">
                    <div className="mb-2 font-medium">当前账号关键字段</div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      {(
                        [
                          ['id', acc.id],
                          ['email', acc.email],
                          ['status', STATUS_LABELS[acc.status] ?? acc.status],
                          ['platform', acc.platform],
                          ['batch_id', acc.batch_id],
                          ['duplicate', acc.duplicate],
                          ['quota_source', acc.quota_source],
                          ['quota_health', acc.quota_health ? (QUOTA_HEALTH_LABELS[acc.quota_health] ?? acc.quota_health) : null],
                          ['quota_percent', acc.quota_source ? `${acc.quota_percent}%` : '未刷新'],
                          ['quota_used_percent', acc.quota_used_percent == null ? null : `${acc.quota_used_percent}%`],
                          ['quota_reset_at', fmtTime(acc.quota_reset_at)],
                          ['expires_at', fmtTime(acc.expires_at)],
                        ] as const
                      ).map(([label, value]) => (
                        <div key={label} className="rounded bg-muted/60 px-2 py-1">
                          <div className="font-mono text-muted-foreground">{label}</div>
                          <div className="break-all">{valueText(value)}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-md border p-3">
                    <div className="mb-2 font-medium">额度窗口快照</div>
                    {windows.length > 0 ? (
                      <div className="space-y-2">
                        {windows.map((w, index) => (
                          <div key={`${valueText(w.key)}-${index}`} className="rounded bg-muted/60 p-2 text-xs">
                            <div className="font-medium">{valueText(w.label)}</div>
                            <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-muted-foreground">
                              <div>已用：{valueText(w.usedPercent)}%</div>
                              <div>可用：{valueText(w.remainingPercent)}%</div>
                              <div>重置：{valueText(w.resetAt)}</div>
                              <div>窗口秒数：{valueText(w.limitWindowSeconds)}</div>
                              <div>触顶：{valueText(w.limitReached)}</div>
                              <div>允许：{valueText(w.allowed)}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-muted-foreground">还没有成功刷新真实额度，暂无快照。</div>
                    )}
                  </div>
                  {quotaSnapshot && (
                    <details className="rounded-md border p-3 text-xs">
                      <summary className="cursor-pointer font-medium">查看 quota_snapshot_json 原始快照</summary>
                      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">
                        {JSON.stringify(quotaSnapshot, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              </div>
            </TabsContent>

            <TabsContent value="tokens" className="space-y-2 text-sm">
              {(
                [
                  ['access_token', acc.access_token],
                  ['refresh_token', acc.refresh_token],
                  ['id_token', acc.id_token],
                  ['mailapi_url', acc.mailapi_url],
                  ['密码', acc.password],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                  <span className="shrink-0 text-muted-foreground">{label}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{value ?? '—'}</span>
                  <Button variant="ghost" size="icon" disabled={!value} onClick={() => copy(value, label)}>
                    <Copy />
                  </Button>
                </div>
              ))}
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
    <ActionErrorDialog error={actionError} onClose={() => setActionError(null)} />
    </>
  );
}
