"use client"

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { api } from "@/features/forum/api/client";
import { Card, CardContent, CardHeader, CardTitle } from "@ggbdpq/console-ui";
import { Separator } from "@ggbdpq/console-ui";

export function SiteSidebar() {
  const { data: categories } = useQuery({
    queryKey: ["categories"],
    queryFn: () => api.listCategories(),
  });
  const { data: stats } = useQuery({
    queryKey: ["stats"],
    queryFn: () => api.getStats(),
  });

  return (
    <aside className="hidden w-72 shrink-0 space-y-4 lg:block">
      {/* 站点简介 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">关于本站</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            一个以逆向工程与安全研究为主，兼顾 Web 开发与 AI 的个人技术社区。聊技术，也聊生活。
          </p>
          {stats && (
            <div className="grid grid-cols-3 gap-2 pt-1 text-center">
              <div>
                <div className="text-lg font-semibold text-foreground">{stats.topicCount}</div>
                <div className="text-xs">话题</div>
              </div>
              <div>
                <div className="text-lg font-semibold text-foreground">{stats.postCount}</div>
                <div className="text-xs">帖子</div>
              </div>
              <div>
                <div className="text-lg font-semibold text-foreground">{stats.userCount}</div>
                <div className="text-xs">会员</div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 分类导航 */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">分类</CardTitle>
            <Link href="/forum/categories" className="text-xs text-primary hover:underline">
              全部 →
            </Link>
          </div>
        </CardHeader>
        <CardContent className="space-y-1">
          {categories?.map((c) => (
            <Link
              key={c.id}
              href={`/forum/c/${c.slug}`}
              className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent"
            >
              <span
                className="inline-block size-2.5 shrink-0 rounded-[4px]"
                style={{ backgroundColor: c.color }}
              />
              <span className="flex-1 truncate">{c.name}</span>
              <span className="text-xs text-muted-foreground">{c.topicCount}</span>
            </Link>
          ))}
          <Separator className="my-2" />
          <p className="px-2 text-xs leading-relaxed text-muted-foreground">
            找不到合适的分类？发到「灌水茶馆」，管理员会帮忙移动。
          </p>
        </CardContent>
      </Card>
    </aside>
  );
}
