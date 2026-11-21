"use client";
import { useCallback, useEffect, useState } from "react";
import { datePlaybookStateSchema, type DatePlaybookState } from "../api-client";
import { SpaceNav } from "../space-nav";
import { UserSwitcher } from "../user-switcher";
import { useDatePlaybookSession } from "@/stores/date-playbook";

const EVENT_LABELS: Record<string, string> = {
  "couple.create": "💘 创建空间",
  "couple.join": "🤝 加入空间",
  "plan.create": "🗓 发起计划",
  "plan.pending_confirmation": "📨 送出确认",
  "plan.confirmed": "✅ 确认计划",
  "plan.completed": "🎉 完成约会",
  "plan.cancelled": "🚫 取消计划",
  "plan.draft": "↩️ 退回草稿",
  "review.create": "📝 复盘",
  "proposal.create": "🌱 阶段提案",
  "proposal.accepted": "💖 提案通过",
  "proposal.declined": "💔 提案婉拒",
};

export default function TimelinePage() {
  const { currentUserId } = useDatePlaybookSession();
  const [state, setState] = useState<DatePlaybookState | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/date-playbook/state?userId=${currentUserId}`);
    setState(datePlaybookStateSchema.parse(await res.json()));
  }, [currentUserId]);

  useEffect(() => {
    void load();
  }, [load]);

  const events = state?.timeline ?? [];

  return (
    <div>
      <SpaceNav active="/date-playbook/timeline" />
      <UserSwitcher />
      {events.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
          还没有动态——创建空间后，这里的每个动作都会自动留痕
        </p>
      ) : (
        <ol className="relative space-y-5 border-l pl-6">
          {events.map((e) => (
            <li key={e.id} className="relative">
              <span className="absolute top-1.5 -left-[27px] size-2.5 rounded-full border-2 border-primary bg-background" />
              <div className="text-sm">
                {EVENT_LABELS[e.type] ?? e.type} <span className="text-foreground/90">{e.detail}</span>
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {e.actor === "user-a" ? "阿关" : "秀秀"} · {e.at.replace("T", " ").slice(0, 16)}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
