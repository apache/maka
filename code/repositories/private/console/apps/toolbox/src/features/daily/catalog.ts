import type { ArchiveRow, DailyReport, NewsItem } from "@/schemas/daily"
import { rankItemsBySemanticQuery } from "@/features/daily/insights"
import { seededReports } from "@/data/daily-seed"

export function listReports(): DailyReport[] {
  return seededReports.toSorted((left, right) => right.date.localeCompare(left.date))
}

export function latestReportDate(): string {
  return listReports()[0]?.date ?? "2026-06-09"
}

export function getReport(date: string): DailyReport | undefined {
  return seededReports.find((report) => report.date === date)
}

export function archiveRows(): ArchiveRow[] {
  return listReports().map((report) => ({
    date: report.date,
    generatedAt: report.generatedAt,
    leadTitle: report.lead?.title ?? null,
    itemCount: report.stats.itemCount,
    selectedCount: report.stats.selectedCount,
  }))
}

export function allItems(): NewsItem[] {
  return listReports().flatMap((report) => report.sections.flatMap((section) => section.items))
}

export function reportCategories(reports: DailyReport[] = seededReports): string[] {
  return [...new Set(reports.flatMap((report) => report.sections.flatMap((section) => section.items.map((item) => item.category))))].sort()
}

export function reportSources(reports: DailyReport[] = seededReports): string[] {
  return [...new Set(reports.flatMap((report) => report.sections.flatMap((section) => section.items.flatMap((item) => item.sources.map((source) => source.name)))))].sort()
}

export function filterItems(input: {
  keyword?: string
  category?: string
  source?: string
  selectedOnly?: boolean
  semantic?: boolean
}): NewsItem[] {
  let items = allItems()
  if (input.category) items = items.filter((item) => item.category === input.category)
  if (input.source) items = items.filter((item) => item.sources.some((source) => source.name === input.source))
  if (input.selectedOnly) items = items.filter((item) => item.selected)
  const keyword = input.keyword?.trim()
  if (!keyword) return items
  if (input.semantic) return rankItemsBySemanticQuery(items, keyword)
  const needle = keyword.toLowerCase()
  return items.filter((item) =>
    [item.title, item.summary ?? "", item.category, ...item.sources.map((source) => source.name)]
      .join(" ")
      .toLowerCase()
      .includes(needle),
  )
}
