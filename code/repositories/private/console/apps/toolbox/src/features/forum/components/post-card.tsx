"use client"

import { Heart, Link2, Reply } from "lucide-react";
import { findUser } from "@/features/forum/api/client";
import { formatRelativeTime, trustLevelName } from "@/features/forum/lib/format";
import { useForumStore } from "@/features/forum/stores/forum";
import { Button } from "@ggbdpq/console-ui";
import { UserAvatar } from "@/features/forum/components/user-avatar";
import type { Post } from "@/features/forum/schemas/forum";

interface PostCardProps {
  post: Post;
}

/** 简单 Markdown 渲染：段落 + 加粗 + @ 提及高亮 */
function renderContent(content: string) {
  return content.split("\n\n").map((block, i) => (
    <p key={i} className="leading-7">
      {block.split("\n").map((line, j) => (
        <span key={j}>
          {j > 0 && <br />}
          {line.split(/(\*\*[^*]+\*\*|@[\w一-龥-]+)/g).map((seg, k) => {
            if (seg.startsWith("**") && seg.endsWith("**")) {
              return (
                <strong key={k} className="font-semibold text-foreground">
                  {seg.slice(2, -2)}
                </strong>
              );
            }
            if (seg.startsWith("@")) {
              return (
                <span key={k} className="font-medium text-primary">
                  {seg}
                </span>
              );
            }
            return seg;
          })}
        </span>
      ))}
    </p>
  ));
}

export function PostCard({ post }: PostCardProps) {
  const author = findUser(post.authorId);
  const { likedPostIds, toggleLikePost } = useForumStore();
  const liked = likedPostIds.includes(post.id);

  if (!author) return null;

  return (
    <article className="flex gap-4 rounded-xl border border-border bg-card p-5 shadow-sm">
      {/* 作者栏 */}
      <div className="flex w-14 shrink-0 flex-col items-center gap-2">
        <UserAvatar user={author} size="lg" />
        <div className="text-center">
          <div className="max-w-20 truncate text-xs font-medium">{author.nickname}</div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            Lv{author.trustLevel} {trustLevelName(author.trustLevel)}
          </div>
        </div>
      </div>

      {/* 正文 */}
      <div className="min-w-0 flex-1">
        <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {author.title && <span className="mr-2">{author.title}</span>}
            {formatRelativeTime(post.createdAt)}
          </span>
          <span>#{post.floor}</span>
        </div>
        <div className="space-y-3 text-sm text-foreground/90">{renderContent(post.content)}</div>
        <div className="mt-4 flex items-center gap-1 border-t border-border pt-3">
          <Button
            variant={liked ? "default" : "ghost"}
            size="sm"
            className="gap-1.5"
            onClick={() => toggleLikePost(post.id)}
          >
            <Heart className={liked ? "size-3.5 fill-current" : "size-3.5"} />
            {post.likeCount + (liked ? 1 : 0)}
          </Button>
          <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
            <Reply className="size-3.5" />
            回复
          </Button>
          <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
            <Link2 className="size-3.5" />
            分享
          </Button>
        </div>
      </div>
    </article>
  );
}
