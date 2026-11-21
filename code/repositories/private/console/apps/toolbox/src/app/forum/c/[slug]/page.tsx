"use client"

import { useQuery } from "@tanstack/react-query"
import { ChevronRight } from "lucide-react"
import { use } from "react"
import { api } from "@/features/forum/api/client"
import { SiteSidebar } from "@/features/forum/components/site-sidebar"
import { TopicList } from "@/features/forum/components/topic-list"

export default function ForumCategoryPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = use(params)
  const { data: categories } = useQuery({
    queryKey: ["categories"],
    queryFn: () => api.listCategories(),
  })
  const category = categories?.find((c) => c.slug === slug)

  return (
    <div className="flex gap-6">
      <div className="min-w-0 flex-1 space-y-4">
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <span>分类</span>
          <ChevronRight className="size-3.5" />
          {category ? (
            <span className="flex items-center gap-2 font-medium text-foreground">
              <span
                className="inline-block size-2.5 rounded-[4px]"
                style={{ backgroundColor: category.color }}
              />
              {category.name}
            </span>
          ) : (
            <span className="text-foreground">{slug}</span>
          )}
        </div>
        {category ? (
          <p className="-mt-2 text-sm text-muted-foreground">{category.description}</p>
        ) : null}
        <TopicList categoryId={category?.id} />
      </div>
      <SiteSidebar />
    </div>
  )
}
