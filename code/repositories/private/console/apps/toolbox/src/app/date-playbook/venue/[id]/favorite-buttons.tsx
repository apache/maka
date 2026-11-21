"use client";
import { useState } from "react";
import { Button } from "@ggbdpq/console-ui";
import { useDatePlaybookSession } from "@/stores/date-playbook";

/** 源收藏语义：想去/去过互斥，再点取消；未建空间时提示 */
export function FavoriteButtons({ venueId }: { venueId: string }) {
  const currentUserId = useDatePlaybookSession((s) => s.currentUserId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const mark = async (status: "want_to_go" | "visited") => {
    setBusy(true);
    setError("");
    const res = await fetch("/api/date-playbook/favorites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: currentUserId, venueId, status }),
    });
    const json = (await res.json()) as { favorite?: { status: string } | null; error?: string };
    setBusy(false);
    if (!res.ok) setError(json.error ?? "操作失败");
    else setError(json.favorite ? "已记录（同状态再点即取消）" : "已取消标记");
  };

  return (
    <div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void mark("want_to_go")}>
          想去
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void mark("visited")}>
          去过了
        </Button>
      </div>
      {error ? <p className="mt-2 text-xs text-muted-foreground">{error}</p> : null}
    </div>
  );
}
