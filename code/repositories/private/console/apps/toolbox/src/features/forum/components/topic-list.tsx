"use client"

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type TopicSort } from "@/features/forum/api/client";
import { TopicRow } from "@/features/forum/components/topic-row";
import { Skeleton } from "@ggbdpq/console-ui";
import { cn } from "@ggbdpq/console-ui";

const SORT_TABS: { key: TopicSort; label: string }[] = [
  { key: "latest", label: "最新" },
  { key: "top", label: "热门" },
  { key: "replies", label: "回复最多" },
];

interface TopicListProps {
  categoryId?: string;
  showSortTabs?: boolean;
}

export function TopicList({ categoryId, showSortTabs = true }: TopicListProps) {
  const [sort, setSort] = useState<TopicSort>("latest");
  const { data: topics, isLoading } = useQuery({
    queryKey: ["topics", categoryId ?? "all", sort],
    queryFn: () => api.listTopics({ categoryId, sort }),
  });

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      {showSortTabs && (
        <div className="flex items-center gap-1 border-b border-border px-4 py-2.5">
          {SORT_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setSort(tab.key)}
              className={cn(
                "rounded-md px-3 py-1 text-sm transition-colors",
                sort === tab.key
                  ? "bg-primary/10 font-medium text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3 p-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : topics && topics.length > 0 ? (
        topics.map((topic) => <TopicRow key={topic.id} topic={topic} />)
      ) : (
        <p className="p-10 text-center text-sm text-muted-foreground">
          这里还很安静，来发第一个话题吧～
        </p>
      )}
    </div>
  );
}
