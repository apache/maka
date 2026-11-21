"use client"

import { useQuery, useQueryClient } from "@tanstack/react-query"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Eye, Heart, Lock, MessageSquare, Pin } from "lucide-react"
import { use } from "react"
import { api, findCategory } from "@/features/forum/api/client"
import { CategoryBadge } from "@/features/forum/components/category-badge"
import { PostCard } from "@/features/forum/components/post-card"
import { ReplyEditor } from "@/features/forum/components/reply-editor"
import { Skeleton } from "@ggbdpq/console-ui"
import { formatCount, formatRelativeTime } from "@/features/forum/lib/format"

export default function ForumTopicPage({
  params,
}: {
  params: Promise<{ topicId: string }>
}) {
  const { topicId } = use(params)
  const queryClient = useQueryClient()

  const { data: topic, isLoading: topicLoading } = useQuery({
    queryKey: ["topic", topicId],
    queryFn: () => api.getTopic(topicId),
  })
  const { data: posts, isLoading: postsLoading } = useQuery({
    queryKey: ["posts", topicId],
    queryFn: () => api.listPosts(topicId),
  })

  if (!topicLoading && !topic) {
    notFound()
  }

  const category = topic ? findCategory(topic.categoryId) : undefined

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      {topicLoading || !topic ? (
        <Skeleton className="h-20 w-full" />
      ) : (
        <header className="space-y-3">
          <h1 className="flex items-start gap-2 text-xl leading-snug font-semibold">
            {topic.pinned ? <Pin className="mt-1 size-5 shrink-0 rotate-45 text-primary" /> : null}
            {topic.closed ? (
              <Lock className="mt-1 size-5 shrink-0 text-muted-foreground" />
            ) : null}
            {topic.title}
          </h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
            {category ? <CategoryBadge category={category} /> : null}
            {topic.tags.map((tag) => (
              <span key={tag} className="text-xs">
                #{tag}
              </span>
            ))}
            <span className="flex items-center gap-1 text-xs">
              <MessageSquare className="size-3.5" /> {topic.replyCount} 回复
            </span>
            <span className="flex items-center gap-1 text-xs">
              <Eye className="size-3.5" /> {formatCount(topic.viewCount)} 浏览
            </span>
            <span className="flex items-center gap-1 text-xs">
              <Heart className="size-3.5" /> {topic.likeCount} 赞
            </span>
            <span className="text-xs">发布于 {formatRelativeTime(topic.createdAt)}</span>
          </div>
        </header>
      )}

      {postsLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-40 w-full" />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {posts?.map((post) => (
            <PostCard key={post.id} post={post} />
          ))}
        </div>
      )}

      {topic && !topic.closed ? (
        <ReplyEditor
          topicId={topic.id}
          nextFloor={(posts?.length ?? 0) + 1}
          onReplied={() => {
            queryClient.invalidateQueries({ queryKey: ["posts", topicId] })
            queryClient.invalidateQueries({ queryKey: ["topic", topicId] })
            queryClient.invalidateQueries({ queryKey: ["topics"] })
          }}
        />
      ) : null}
      {topic?.closed ? (
        <p className="rounded-xl border border-border bg-muted/50 p-4 text-center text-sm text-muted-foreground">
          该话题已关闭，无法继续回复。
          <Link href="/forum" className="ml-1 text-primary hover:underline">
            返回首页
          </Link>
        </p>
      ) : null}
    </div>
  )
}
