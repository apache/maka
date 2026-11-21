"use client"

import { useQuery } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { api } from "@/features/forum/api/client"
import { newTopicInputSchema } from "@/features/forum/schemas/forum"
import { useAuthStore } from "@/features/forum/stores/auth"
import { useForumStore } from "@/features/forum/stores/forum"
import { Button } from "@ggbdpq/console-ui"
import { Input } from "@ggbdpq/console-ui"
import { Textarea } from "@ggbdpq/console-ui"
import { cn } from "@ggbdpq/console-ui"

export default function ForumNewTopicPage() {
  const router = useRouter()
  const currentUser = useAuthStore((s) => s.currentUser)
  const createTopic = useForumStore((s) => s.createTopic)
  const { data: categories } = useQuery({
    queryKey: ["categories"],
    queryFn: () => api.listCategories(),
  })

  const [title, setTitle] = useState("")
  const [categoryId, setCategoryId] = useState("")
  const [tagsInput, setTagsInput] = useState("")
  const [content, setContent] = useState("")
  const [errors, setErrors] = useState<Record<string, string>>({})

  if (!currentUser) {
    return (
      <div className="mx-auto max-w-md rounded-xl border border-border bg-card p-8 text-center shadow-sm">
        <h1 className="text-lg font-semibold">需要先登录</h1>
        <p className="mt-2 text-sm text-muted-foreground">登录后即可发布新话题</p>
        <Button className="mt-4" onClick={() => router.push("/forum/login")}>
          去登录
        </Button>
      </div>
    )
  }

  const submit = () => {
    const tags = tagsInput
      .split(/[,，\s]+/)
      .map((t) => t.trim().replace(/^#/, ""))
      .filter(Boolean)
    const result = newTopicInputSchema.safeParse({ title, categoryId, tags, content })
    if (!result.success) {
      const fieldErrors: Record<string, string> = {}
      for (const issue of result.error.issues) {
        const key = String(issue.path[0] ?? "form")
        if (!fieldErrors[key]) fieldErrors[key] = issue.message
      }
      setErrors(fieldErrors)
      return
    }
    const topic = createTopic(result.data, currentUser)
    router.push(`/forum/t/${topic.id}`)
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold">发布新话题</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          标题说清主题，正文讲透细节，好问题自带答案的一半
        </p>
      </div>

      <div className="space-y-4 rounded-xl border border-border bg-card p-6 shadow-sm">
        <div className="space-y-1.5">
          <label htmlFor="topic-title" className="text-sm font-medium">
            标题
          </label>
          <Input
            id="topic-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="一句话说清主题，5-80 个字符"
            maxLength={80}
          />
          {errors.title ? <p className="text-sm text-destructive">{errors.title}</p> : null}
        </div>

        <div className="space-y-1.5">
          <span className="text-sm font-medium">分类</span>
          <div className="flex flex-wrap gap-2">
            {categories?.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setCategoryId(c.id)}
                className={cn(
                  "flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors",
                  categoryId === c.id
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:bg-accent",
                )}
              >
                <span
                  className="inline-block size-2 rounded-[3px]"
                  style={{ backgroundColor: c.color }}
                />
                {c.name}
              </button>
            ))}
          </div>
          {errors.categoryId ? (
            <p className="text-sm text-destructive">{errors.categoryId}</p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <label htmlFor="topic-tags" className="text-sm font-medium">
            标签 <span className="font-normal text-muted-foreground">（可选，空格分隔，最多 5 个）</span>
          </label>
          <Input
            id="topic-tags"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder="例如：IDA 教程 入门"
          />
          {errors.tags ? <p className="text-sm text-destructive">{errors.tags}</p> : null}
        </div>

        <div className="space-y-1.5">
          <label htmlFor="topic-content" className="text-sm font-medium">
            正文
          </label>
          <Textarea
            id="topic-content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="至少 20 个字符。支持 **加粗** 与 @ 提及。"
            rows={10}
          />
          {errors.content ? <p className="text-sm text-destructive">{errors.content}</p> : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button variant="ghost" onClick={() => router.push("/forum")}>
            取消
          </Button>
          <Button onClick={submit}>发布话题</Button>
        </div>
      </div>
    </div>
  )
}
