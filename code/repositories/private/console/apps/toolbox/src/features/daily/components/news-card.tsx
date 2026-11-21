import Link from "next/link"
import type { NewsItem } from "@/schemas/daily"

export function NewsCard({ item }: { item: NewsItem }) {
  return (
    <article className="rounded-xl border bg-card p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {item.selected ? (
          <span className="rounded-md bg-accent px-1.5 py-0.5 text-accent-foreground">精选</span>
        ) : null}
        <span className="rounded-md border px-1.5 py-0.5">{item.category}</span>
        {item.publishedAt ? <time dateTime={item.publishedAt}>{new Date(item.publishedAt).toLocaleDateString("zh-CN")}</time> : null}
      </div>
      <a href={item.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
        {item.title}
      </a>
      {item.summary ? <p className="mt-2 text-sm text-muted-foreground">{item.summary}</p> : null}
      {item.aiSummary ? <p className="mt-2 text-sm">{item.aiSummary}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
        {item.sources.map((source) => (
          <span key={`${source.kind}-${source.name}`}>{source.name}</span>
        ))}
        <Link href={item.url} target="_blank" rel="noreferrer" className="ml-auto text-primary">
          原文
        </Link>
      </div>
    </article>
  )
}
