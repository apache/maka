"use client"

import { useQuery } from "@tanstack/react-query"
import Link from "next/link"
import { api } from "@/features/forum/api/client"
import { Skeleton } from "@ggbdpq/console-ui"

export default function ForumCategoriesPage() {
  const { data: categories, isLoading } = useQuery({
    queryKey: ["categories"],
    queryFn: () => api.listCategories(),
  })

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold">全部分类</h1>
        <p className="mt-1 text-sm text-muted-foreground">选择一个感兴趣的版块开始浏览</p>
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {categories?.map((c) => (
            <Link
              key={c.id}
              href={`/forum/c/${c.slug}`}
              className="group rounded-xl border border-border bg-card p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md"
            >
              <div className="flex items-center gap-2.5">
                <span
                  className="inline-block size-3 rounded-[5px]"
                  style={{ backgroundColor: c.color }}
                />
                <h2 className="font-medium group-hover:text-primary">{c.name}</h2>
              </div>
              <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{c.description}</p>
              <div className="mt-3 flex gap-4 text-xs text-muted-foreground">
                <span>{c.topicCount} 话题</span>
                <span>{c.postCount} 帖子</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
