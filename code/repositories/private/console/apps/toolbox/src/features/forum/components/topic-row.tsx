"use client"

import Link from "next/link";
import { Eye, Lock, MessageSquare, Pin } from "lucide-react";
import { findCategory, findUser } from "@/features/forum/api/client";
import { formatCount, formatRelativeTime } from "@/features/forum/lib/format";
import { CategoryBadge } from "@/features/forum/components/category-badge";
import { UserAvatar } from "@/features/forum/components/user-avatar";
import type { Topic } from "@/features/forum/schemas/forum";

interface TopicRowProps {
  topic: Topic;
}

export function TopicRow({ topic }: TopicRowProps) {
  const category = findCategory(topic.categoryId);
  const participants = topic.participantIds
    .map(findUser)
    .filter((u): u is NonNullable<typeof u> => Boolean(u))
    .slice(0, 5);

  return (
    <article className="group flex items-center gap-4 border-b border-border px-4 py-3.5 transition-colors hover:bg-accent/50">
      {/* 参与者头像簇 */}
      <div className="hidden w-24 shrink-0 items-center sm:flex">
        {participants.map((user, i) => (
          <UserAvatar
            key={user.id}
            user={user}
            size="sm"
            className={i === 0 ? "" : "-ml-2 ring-2 ring-card"}
          />
        ))}
      </div>

      {/* 标题区 */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {topic.pinned && (
            <Pin className="size-3.5 shrink-0 rotate-45 text-primary" aria-label="置顶" />
          )}
          {topic.closed && (
            <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-label="已关闭" />
          )}
          <Link
            href={`/forum/t/${topic.id}`}
            className="truncate text-[15px] font-medium text-foreground group-hover:text-primary"
          >
            {topic.title}
          </Link>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {category && <CategoryBadge category={category} />}
          {topic.tags.map((tag) => (
            <span key={tag} className="text-xs text-muted-foreground">
              #{tag}
            </span>
          ))}
        </div>
      </div>

      {/* 统计区 */}
      <div className="flex shrink-0 items-center gap-5 text-sm text-muted-foreground">
        <span className="flex w-12 items-center justify-end gap-1" title="回复数">
          <MessageSquare className="size-3.5" />
          <span className={topic.replyCount > 20 ? "font-semibold text-primary" : ""}>
            {formatCount(topic.replyCount)}
          </span>
        </span>
        <span className="hidden w-12 items-center justify-end gap-1 md:flex" title="浏览数">
          <Eye className="size-3.5" />
          {formatCount(topic.viewCount)}
        </span>
        <span className="w-16 text-right text-xs">
          {formatRelativeTime(topic.lastActivityAt)}
        </span>
      </div>
    </article>
  );
}
