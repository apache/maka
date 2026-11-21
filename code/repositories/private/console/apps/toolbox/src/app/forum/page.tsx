import { SiteSidebar } from "@/features/forum/components/site-sidebar"
import { TopicList } from "@/features/forum/components/topic-list"

export default function ForumHomePage() {
  return (
    <div className="flex gap-6">
      <div className="min-w-0 flex-1 space-y-4">
        <div className="rounded-xl border border-primary/20 bg-gradient-to-r from-primary/10 via-accent to-transparent p-5">
          <h1 className="text-lg font-semibold">欢迎来到 ggbdpq 论坛</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            逆向工程、二进制安全、Web 开发、AI 大模型。一个有温度的小众技术角落
          </p>
        </div>
        <TopicList />
      </div>
      <SiteSidebar />
    </div>
  )
}
