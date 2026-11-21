"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Rate, Textarea } from "@ggbdpq/console-ui";
import { SpaceNav } from "../../../space-nav";
import { UserSwitcher } from "../../../user-switcher";
import { useDatePlaybookSession } from "@/stores/date-playbook";

// 独立复盘页（源 review.schema：1-5 星 + 亮点 + 下次改进）
export default function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const currentUserId = useDatePlaybookSession((s) => s.currentUserId);
  const [planId, setPlanId] = useState("");
  const [rating, setRating] = useState(5);
  const [highlights, setHighlights] = useState("");
  const [improvements, setImprovements] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void params.then(({ id }) => setPlanId(id));
  }, [params]);

  const submit = async () => {
    setBusy(true);
    const res = await fetch(`/api/date-playbook/plans/${planId}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: currentUserId, rating, highlights: highlights.trim(), improvements: improvements.trim() }),
    });
    setBusy(false);
    if (!res.ok) {
      const json = (await res.json()) as { error?: string };
      setError(json.error ?? "提交失败");
      return;
    }
    router.push(`/date-playbook/plans/${planId}`);
  };

  return (
    <div>
      <SpaceNav active="/date-playbook/plans" />
      <UserSwitcher />
      <header className="mb-6">
        <h1 className="text-3xl font-semibold tracking-tight">约会复盘</h1>
        <p className="mt-1 text-sm text-muted-foreground">记录这一次的亮点与下次可以更好的地方</p>
      </header>
      <div className="max-w-lg space-y-4 rounded-lg border p-5">
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div>
          <span className="mb-1.5 block text-sm font-medium">这次体验几颗星 *</span>
          <Rate value={rating} onChange={setRating} />
        </div>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">亮点</span>
          <Textarea rows={3} value={highlights} onChange={(e) => setHighlights(e.target.value)} placeholder="哪些瞬间值得记住" />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">下次改进</span>
          <Textarea rows={3} value={improvements} onChange={(e) => setImprovements(e.target.value)} placeholder="可以做得更好的地方" />
        </label>
        <div className="flex justify-end">
          <Button disabled={busy} onClick={() => void submit()}>
            提交复盘
          </Button>
        </div>
      </div>
    </div>
  );
}
