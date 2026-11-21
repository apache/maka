"use client"

import { useState } from "react";
import { useRouter } from "next/navigation";
import { replyInputSchema } from "@/features/forum/schemas/forum";
import { useAuthStore } from "@/features/forum/stores/auth";
import { useForumStore } from "@/features/forum/stores/forum";
import { Button } from "@ggbdpq/console-ui";
import { Textarea } from "@ggbdpq/console-ui";
import { UserAvatar } from "@/features/forum/components/user-avatar";

interface ReplyEditorProps {
  topicId: string;
  nextFloor: number;
  onReplied: () => void;
}

export function ReplyEditor({ topicId, nextFloor, onReplied }: ReplyEditorProps) {
  const router = useRouter();
  const currentUser = useAuthStore((s) => s.currentUser);
  const createReply = useForumStore((s) => s.createReply);
  const [content, setContent] = useState("");
  const [error, setError] = useState("");

  if (!currentUser) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-card/50 p-6 text-center">
        <p className="text-sm text-muted-foreground">登录后即可参与讨论</p>
        <Button className="mt-3" onClick={() => router.push("/forum/login")}>
          去登录
        </Button>
      </div>
    );
  }

  const submit = () => {
    const result = replyInputSchema.safeParse({ topicId, content });
    if (!result.success) {
      setError(result.error.issues[0]?.message ?? "内容不合法");
      return;
    }
    createReply(result.data, currentUser, nextFloor);
    setContent("");
    setError("");
    onReplied();
  };

  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex gap-3">
        <UserAvatar user={currentUser} size="md" />
        <div className="flex-1 space-y-3">
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="友善回复，理性讨论。支持 **加粗** 与 @ 提及。"
            rows={4}
            aria-label="回复内容"
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">至少 5 个字符</span>
            <Button onClick={submit}>发表回复</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
