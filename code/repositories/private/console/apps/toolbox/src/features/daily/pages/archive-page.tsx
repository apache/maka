import Link from "next/link"
import { archiveRows } from "@/features/daily/catalog"

export function ArchivePage() {
  const rows = archiveRows()

  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold">归档</h1>
      <ul className="space-y-3">
        {rows.map((row) => (
          <li key={row.date}>
            <Link href={`/daily/${row.date}`} className="block rounded-xl border bg-card p-4 hover:bg-accent">
              <div className="font-medium">{row.date}</div>
              <p className="mt-1 text-sm text-muted-foreground">{row.leadTitle}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                {row.itemCount} 条 · 精选 {row.selectedCount}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
