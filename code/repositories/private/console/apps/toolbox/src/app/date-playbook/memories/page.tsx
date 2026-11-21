import type { Metadata } from "next";
import { Badge } from "@ggbdpq/console-ui";
import { SpaceNav } from "../space-nav";
import { DEMO_ARCHIVE_SEED } from "@/features/date-playbook/mock/archive.demo.seed";

// 回忆页（源 memories + archive/items：事实卡分组 + 已聊话题/避雷）

export const metadata: Metadata = { title: "回忆" };

export default function MemoriesPage() {
  const { facts, items, askedTopics, doNotRepeat } = DEMO_ARCHIVE_SEED;

  return (
    <div>
      <SpaceNav active="/date-playbook/memories" />
      <header className="mb-6">
        <h1 className="text-3xl font-semibold tracking-tight">回忆</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          对方随口提过的事，都值得被记住（演示数据，不含聊天原文）
        </p>
      </header>

      <section className="mb-8 grid gap-3 sm:grid-cols-3">
        {(
          [
            { label: "所在地", values: facts.location },
            { label: "工作作息", values: facts.job },
            { label: "生活习惯", values: facts.habits },
          ] as const
        ).map((group) => (
          <div key={group.label} className="rounded-lg border p-4">
            <h3 className="text-xs font-semibold text-muted-foreground">{group.label}</h3>
            <ul className="mt-2 space-y-1 text-sm">
              {group.values.map((v, i) => (
                <li key={i}>{v}</li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-lg font-semibold">事实卡片（{items.length}）</h2>
        {items.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">暂无</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {items.map((item) => (
              <div key={item.id} className="rounded-lg border p-4 text-sm">
                <div className="flex items-center justify-between">
                  <Badge variant="secondary">{item.subcategory}</Badge>
                  {item.date ? <span className="text-xs text-muted-foreground">{item.date}</span> : null}
                </div>
                <p className="mt-2 font-medium">{item.summary}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <section className="rounded-lg border border-dashed p-4">
          <h3 className="mb-2 font-medium">聊过的话题</h3>
          <div className="flex flex-wrap gap-1.5">
            {askedTopics.length > 0 ? (
              askedTopics.map((t) => (
                <Badge key={t.id} variant={t.answered ? "secondary" : "outline"}>
                  {t.topic}
                  {t.answered ? "" : "（未答）"}
                </Badge>
              ))
            ) : (
              <span className="text-sm text-muted-foreground">暂无</span>
            )}
          </div>
        </section>
        <section className="rounded-lg border border-dashed p-4">
          <h3 className="mb-2 font-medium">不要再提</h3>
          <ul className="space-y-1 text-sm">
            {doNotRepeat.length > 0 ? (
              doNotRepeat.map((d, i) => (
                <li key={i} className="text-muted-foreground">
                  {d.summary}
                </li>
              ))
            ) : (
              <span className="text-sm text-muted-foreground">暂无</span>
            )}
          </ul>
        </section>
      </div>
    </div>
  );
}
