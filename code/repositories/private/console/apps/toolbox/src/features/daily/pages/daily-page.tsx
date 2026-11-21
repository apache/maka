"use client"

import Link from "next/link"
import { useMemo, useState } from "react"
import { Button } from "@ggbdpq/console-ui"
import { NewsCard } from "@/features/daily/components/news-card"
import { InsightsPanel } from "@/features/daily/components/insights-panel"
import { archiveRows, getReport, listReports } from "@/features/daily/catalog"
import { buildDailyInsights, enrichReportWithSummaries } from "@/features/daily/insights"
import type { DailyReport } from "@/schemas/daily"

export function DailyPage({ date }: { date: string }) {
  const base = getReport(date)
  const [report, setReport] = useState<DailyReport | undefined>(base)
  const [notice, setNotice] = useState<string | null>(null)
  const archive = archiveRows()
  const insights = useMemo(
    () => (report ? buildDailyInsights(report, listReports()) : null),
    [report],
  )

  if (!report) {
    return <p className="text-sm text-muted-foreground">这一天还没有离线样本。</p>
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">{report.date}</p>
          <h1 className="text-xl font-semibold">{report.lead?.title ?? "AI 日报"}</h1>
          {report.lead?.paragraph ? <p className="mt-1 text-sm text-muted-foreground">{report.lead.paragraph}</p> : null}
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setNotice("演示站使用离线样本，不会请求外网。")}
          >
            立即同步
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setReport(enrichReportWithSummaries({ ...report, sections: report.sections.map((section) => ({
                ...section,
                items: section.items.map((item) => ({ ...item, aiSummary: null })),
              })) }))
              setNotice("已用本地规则重算摘要。")
            }}
          >
            重算摘要
          </Button>
        </div>
      </header>
      {notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}
      <div className="flex flex-wrap gap-4 text-sm">
        <span>条目 {report.stats.itemCount}</span>
        <span>精选 {report.stats.selectedCount}</span>
        <span>信源 {report.stats.sourceCount}</span>
      </div>
      <nav className="flex flex-wrap gap-2 text-sm">
        {archive.map((row) => (
          <Link
            key={row.date}
            href={`/daily/${row.date}`}
            className={`rounded-md border px-2 py-1 ${row.date === date ? "border-primary text-primary" : "text-muted-foreground"}`}
          >
            {row.date}
          </Link>
        ))}
      </nav>
      {insights ? <InsightsPanel insights={insights} /> : null}
      <div className="space-y-6">
        {report.sections.map((section) => (
          <section key={section.label}>
            <h2 className="mb-3 text-sm font-semibold">{section.label}</h2>
            <div className="grid gap-3">
              {section.items.map((item) => (
                <NewsCard key={item.id} item={item} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
