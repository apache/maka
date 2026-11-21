import {
  dailyInsightsSchema,
  type DailyInsights,
  type DailyReport,
  type NewsItem,
} from "@/schemas/daily"

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "into",
  "are",
  "our",
  "your",
  "about",
  "update",
  "teams",
])

function tokenize(value: string): string[] {
  const normalized = value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")
  return [...new Set(normalized.split(/\s+/).filter((token) => token.length > 1 && !STOP_WORDS.has(token)))]
}

function reportItems(report: DailyReport): NewsItem[] {
  return report.sections.flatMap((section) => section.items)
}

export function buildStructuredSummary(item: NewsItem): string {
  const base = item.summary ?? item.title
  const sources = item.sources.map((source) => source.name).join("、")
  return `发生了什么：${base} 为什么重要：这条动态属于 ${item.category}，并被 ${item.sources.length} 个来源记录。 影响谁：关注 ${item.category}、产品策略和工程落地的团队应跟进。 来源：${sources}`
}

export function enrichReportWithSummaries(report: DailyReport): DailyReport {
  return {
    ...report,
    sections: report.sections.map((section) => ({
      ...section,
      items: section.items.map((item) => ({
        ...item,
        aiSummary: item.aiSummary ?? buildStructuredSummary(item),
      })),
    })),
  }
}

function scoreItem(item: NewsItem): number {
  const base = (item.selected ? 40 : 0) + item.sources.length * 15 + (item.summary ? 5 : 0)
  return base + Math.min(item.title.length, 80)
}

function topItemReason(item: NewsItem): string {
  if (item.selected) {
    return `精选条目，来自 ${item.sources.length} 个来源，属于 ${item.category}。`
  }
  return `来源信号较强，属于 ${item.category}。`
}

function buildThemes(items: NewsItem[]): DailyInsights["themes"] {
  const buckets = new Map<string, NewsItem[]>()
  for (const item of items) {
    buckets.set(item.category, [...(buckets.get(item.category) ?? []), item])
  }
  return [...buckets.entries()]
    .map(([category, bucket]) => ({
      id: category,
      label: `${category} theme`,
      keywords: tokenize(bucket.map((item) => `${item.title} ${item.summary ?? ""}`).join(" ")).slice(0, 6),
      itemIds: bucket.map((item) => item.id),
    }))
    .sort((left, right) => right.itemIds.length - left.itemIds.length)
}

function buildTrends(reports: DailyReport[]): DailyInsights["trends"] {
  const buckets = new Map<string, Set<string>>()
  for (const report of reports) {
    for (const item of reportItems(report)) {
      buckets.set(item.category, (buckets.get(item.category) ?? new Set()).add(report.date))
    }
  }
  return [...buckets.entries()]
    .map(([label, dates]) => ({
      label,
      count: dates.size,
      dates: [...dates].sort(),
    }))
    .sort((left, right) => right.count - left.count)
}

export function buildDailyInsights(report: DailyReport, reports: DailyReport[] = [report]): DailyInsights {
  const items = reportItems(report)
  const topItems = [...items]
    .sort((left, right) => scoreItem(right) - scoreItem(left))
    .slice(0, 5)
    .map((item) => ({
      id: item.id,
      title: item.title,
      score: scoreItem(item),
      reason: topItemReason(item),
    }))

  return dailyInsightsSchema.parse({
    date: report.date,
    topItems,
    themes: buildThemes(items),
    trends: buildTrends(reports),
  })
}

export function rankItemsBySemanticQuery(items: NewsItem[], query: string): NewsItem[] {
  const queryTokens = new Set(tokenize(query))
  return [...items]
    .map((item) => {
      const itemTokens = new Set(
        tokenize(`${item.title} ${item.summary ?? ""} ${item.category} ${item.sources.map((source) => source.name).join(" ")}`),
      )
      const overlap = [...queryTokens].filter((token) => itemTokens.has(token)).length
      return { item, score: overlap * 10 + (item.selected ? 2 : 0) + item.sources.length }
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.item)
}
