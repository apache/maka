import type { AskedTopic, DoNotRepeatItem, PartnerArchive, PartnerFactItem } from '@/features/date-playbook/domain/types'
import { createEmptyFamilyTree } from '@/features/date-playbook/domain/archive/familyTree'

export interface ArchiveItemFilter {
  query?: string
  category?: 'all' | 'life' | 'relationship'
  subcategory?: string
  repeatRisk?: 'all' | 'high' | 'medium' | 'low'
}

export interface TopicTreeNode {
  id: string
  title: string
  count: number
  summaries?: string[]
  children: TopicTreeNode[]
}

export interface PagedResult<T> {
  items: T[]
  currentPage: number
  totalPages: number
  totalItems: number
  pageSize: number
}

const RELATIONSHIP_BUCKETS = ['边界与雷区', '价值观与判断', '相处偏好']
const LIFE_BUCKETS = ['工作情况', '生活区域', '兴趣与休闲', '作息', '饮食']

export function filterPartnerItems(
  items: PartnerFactItem[],
  filters: ArchiveItemFilter = {}
): PartnerFactItem[] {
  const query = (filters.query || '').trim().toLowerCase()
  const category = filters.category || 'all'
  const subcategory = (filters.subcategory || '').trim()
  const repeatRisk = filters.repeatRisk || 'all'

  return items.filter((item) => {
    if (query && !item.summary.toLowerCase().includes(query)) return false
    if (category !== 'all' && item.category !== category) return false
    if (subcategory && item.subcategory !== subcategory) return false
    if (repeatRisk !== 'all' && item.repeatRisk !== repeatRisk) return false
    return true
  })
}

export function paginateItems<T>(items: T[], page: number, pageSize: number): PagedResult<T> {
  const safePageSize = Math.max(1, pageSize || 20)
  const totalPages = Math.max(1, Math.ceil(items.length / safePageSize) || 1)
  const currentPage = Math.min(Math.max(1, page || 1), totalPages)
  const start = (currentPage - 1) * safePageSize
  return {
    items: items.slice(start, start + safePageSize),
    currentPage,
    totalPages,
    totalItems: items.length,
    pageSize: safePageSize
  }
}

export function groupItemsBySubcategory(items: PartnerFactItem[]): Array<{ title: string; items: PartnerFactItem[] }> {
  const groups = new Map<string, PartnerFactItem[]>()
  items.forEach((item) => {
    const title = item.subcategory || '其他'
    const bucket = groups.get(title)
    if (bucket) bucket.push(item)
    else groups.set(title, [item])
  })
  return Array.from(groups.entries()).map(([title, grouped]) => ({ title, items: grouped }))
}

function buildBucketNodes(items: PartnerFactItem[], bucketTitles: string[]): TopicTreeNode[] {
  return bucketTitles.flatMap((title) => {
    const matched = items.filter((item) => item.subcategory === title)
    if (!matched.length) return []
    return [
      {
        id: title,
        title,
        count: matched.length,
        summaries: matched.slice(0, 3).map((item) => item.summary),
        children: []
      }
    ]
  })
}

export function buildArchiveTopicTree(items: PartnerFactItem[], askedTopics: AskedTopic[]): TopicTreeNode[] {
  const asked = askedTopics.filter((item) => item.answered)
  const pending = askedTopics.filter((item) => item.answered === false)

  return [
    {
      id: 'relationship-root',
      title: '关系主题',
      count: RELATIONSHIP_BUCKETS.reduce(
        (sum, title) => sum + items.filter((item) => item.subcategory === title).length,
        0
      ),
      children: buildBucketNodes(items, RELATIONSHIP_BUCKETS)
    },
    {
      id: 'life-root',
      title: '生活主题',
      count: LIFE_BUCKETS.reduce(
        (sum, title) => sum + items.filter((item) => item.subcategory === title).length,
        0
      ),
      children: buildBucketNodes(items, LIFE_BUCKETS)
    },
    {
      id: 'progress-root',
      title: '互动进展',
      count: askedTopics.length,
      children: [
        {
          id: 'asked-topics',
          title: '你已问过的话题',
          count: asked.length,
          summaries: asked.slice(0, 5).map((item) => item.topic),
          children: []
        },
        {
          id: 'pending-topics',
          title: '还可继续深聊的话题',
          count: pending.length,
          summaries: pending.slice(0, 5).map((item) => item.topic),
          children: []
        }
      ]
    }
  ]
}

function repeatKeywords(summary: string): string[] {
  const keys: string[] = []
  if (summary.includes('职业') || summary.includes('工作')) keys.push('工作', '职业', '做什么')
  if (summary.includes('区域') || summary.includes('住')) keys.push('住哪', '在哪', '哪里人', '住哪')
  if (summary.includes('不喜欢') || summary.includes('雷区')) keys.push('不喜欢')
  return keys
}

export function findRepeatRisks(text: string, items: DoNotRepeatItem[]): DoNotRepeatItem[] {
  const draft = text.trim()
  if (!draft) return []
  return items.filter((item) => repeatKeywords(item.summary).some((key) => draft.includes(key)))
}

export function createEmptyArchive(
  partnerName = '对方',
  source: 'demo' | 'chat-memory' = 'demo'
): PartnerArchive {
  return {
    enabled: false,
    source,
    partnerName,
    facts: { location: [], job: [], habits: [] },
    items: [],
    askedTopics: [],
    doNotRepeat: [],
    visits: [],
    familyTree: createEmptyFamilyTree()
  }
}
