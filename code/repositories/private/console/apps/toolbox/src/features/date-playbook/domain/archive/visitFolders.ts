import type { VisitMemory } from '@/features/date-playbook/domain/types'

const SKIP_VISIT_FOLDERS = new Set(['videos', '交通与距离', '朋友圈照片', '美美的秀秀'])

/**
 * 解析 chat-memory/timeline 目录名。
 * 例：20260218-年初二-在家吃饭&&晚上去她大姑家烧烤
 */
export function parseVisitFolderName(name: string): VisitMemory | null {
  const trimmed = name.trim()
  if (!trimmed || SKIP_VISIT_FOLDERS.has(trimmed)) return null
  const matched = /^(\d{8})-([^-]+)-(.+)$/.exec(trimmed)
  if (!matched) return null
  const rawDate = matched[1]
  return {
    date: `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`,
    title: matched[2],
    content: matched[3].replace(/&&/g, '；')
  }
}

export function parseVisitFolderNames(names: string[]): VisitMemory[] {
  return names
    .map(parseVisitFolderName)
    .filter((item): item is VisitMemory => item !== null)
    .sort((a, b) => a.date.localeCompare(b.date))
}
