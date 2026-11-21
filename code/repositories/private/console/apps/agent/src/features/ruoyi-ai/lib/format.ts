import type { ParseStatus } from './domain/types'

const pad = (n: number) => String(n).padStart(2, '0')

export function formatDate(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export const STATUS_META: Record<ParseStatus, { label: string; dot: string; text: string }> = {
  pending: { label: '待解析', dot: 'bg-muted-foreground', text: 'text-muted-foreground' },
  parsing: { label: '解析中', dot: 'bg-amber-400', text: 'text-amber-400' },
  parsed: { label: '已解析', dot: 'bg-emerald-500', text: 'text-emerald-500' },
  failed: { label: '失败', dot: 'bg-destructive', text: 'text-destructive' },
}

export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
