import type { Metadata } from "next";
import { Badge } from "@ggbdpq/console-ui";
import { formatDate } from "@/components/article-card";
import { growthEntries } from "@/data/articles";

export const metadata: Metadata = {
  title: "成长",
  description: "复盘、习惯与阅读方法论",
};

export default function GrowthPage() {
  const entries = [...growthEntries].sort((a, b) => b.date.localeCompare(a.date));

  return (
    <div>
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">成长</h1>
        <p className="mt-1 text-sm text-muted-foreground">长期主义的本质是「不下牌桌」</p>
      </header>
      <ol className="relative space-y-8 border-l pl-6">
        {entries.map((entry) => (
          <li key={entry.id} className="relative">
            <span className="absolute top-1.5 -left-[27px] size-2.5 rounded-full border-2 border-primary bg-background" />
            <div className="text-sm text-muted-foreground">{formatDate(entry.date)}</div>
            <h2 className="mt-1 font-semibold">{entry.title}</h2>
            <p className="mt-2 leading-7 text-foreground/90">{entry.content}</p>
            <div className="mt-2 flex gap-1.5">
              {entry.tags.map((tag) => (
                <Badge key={tag} variant="secondary">
                  {tag}
                </Badge>
              ))}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
