import type { PracticeType } from '@ggbdpq/console-shared'

/** 类型 → 展示样式（Badge 语义变体 + 圆点色） */
export const PRACTICE_TYPE_UI: Record<
  PracticeType,
  { label: string; longLabel: string; badge: 'success' | 'warning' | 'info'; dot: string }
> = {
  pr: { label: '功能', longLabel: '功能新增（PR）', badge: 'success', dot: 'bg-success' },
  issue: { label: '修复', longLabel: '缺陷修复（Issue）', badge: 'warning', dot: 'bg-warning' },
  other: { label: '其他', longLabel: '其他改动', badge: 'info', dot: 'bg-info' },
}

/** 仓库短名（看板卡片空间有限） */
export function repoAlias(repo: string): string {
  return repo
    .replace(/^beauty-smart-advisor$/, 'advisor')
    .replace(/^homing-miniapp-/, '')
    .replace(/^homing-/, '')
}

export function formatDate(iso: string): string {
  return iso.slice(0, 10)
}
