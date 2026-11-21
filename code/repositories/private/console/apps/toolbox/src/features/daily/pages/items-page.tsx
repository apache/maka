"use client"

import { useMemo, useState } from "react"
import { Input } from "@ggbdpq/console-ui"
import { NewsCard } from "@/features/daily/components/news-card"
import { filterItems, reportCategories, reportSources } from "@/features/daily/catalog"

export function ItemsPage() {
  const [keyword, setKeyword] = useState("")
  const [category, setCategory] = useState("")
  const [source, setSource] = useState("")
  const [selectedOnly, setSelectedOnly] = useState(false)
  const [semantic, setSemantic] = useState(true)
  const categories = reportCategories()
  const sources = reportSources()
  const items = useMemo(
    () => filterItems({ keyword, category: category || undefined, source: source || undefined, selectedOnly, semantic }),
    [keyword, category, source, selectedOnly, semantic],
  )

  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold">全部动态</h1>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder={semantic ? "语义检索，例如 code review agent" : "关键词"}
        />
        <select className="h-9 rounded-md border bg-transparent px-3 text-sm" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">全部分类</option>
          {categories.map((item) => (
            <option key={item} value={item}>{item}</option>
          ))}
        </select>
        <select className="h-9 rounded-md border bg-transparent px-3 text-sm" value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">全部来源</option>
          {sources.map((item) => (
            <option key={item} value={item}>{item}</option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={selectedOnly} onChange={(e) => setSelectedOnly(e.target.checked)} />
          只看精选
        </label>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={semantic} onChange={(e) => setSemantic(e.target.checked)} />
          语义检索（本地分词重叠，不打外网）
        </label>
      </div>
      <p className="mb-3 text-sm text-muted-foreground">共 {items.length} 条</p>
      <div className="grid gap-3">
        {items.map((item) => (
          <NewsCard key={item.id} item={item} />
        ))}
      </div>
    </div>
  )
}
