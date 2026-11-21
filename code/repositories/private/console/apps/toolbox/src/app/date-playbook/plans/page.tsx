"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Badge, Button } from "@ggbdpq/console-ui";
import { PLAN_STATUS_LABELS } from "@/schemas/date-playbook";
import type { DatePlaybookState } from "../api-client";
import { SpaceNav } from "../space-nav";
import { UserSwitcher } from "../user-switcher";
import { useDatePlaybookSession } from "@/stores/date-playbook";

export default function PlansPage() {
  const currentUserId = useDatePlaybookSession((s) => s.currentUserId);
  const [state, setState] = useState<DatePlaybookState | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/date-playbook/state?userId=${currentUserId}`);
      setState((await res.json()) as DatePlaybookState);
      setError("");
    } catch {
      setError("加载失败，请稍后重试");
    }
  }, [currentUserId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <SpaceNav active="/date-playbook/plans" />
      <UserSwitcher />
      {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}

      {!state?.couple ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="text-muted-foreground">还没有两人空间——先到「我们」页创建或用邀请码加入</p>
          <Link href="/date-playbook/couple" className="mt-3 inline-block text-primary hover:underline">
            去创建空间 →
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">{state.plans.length} 个计划</p>
            <Link href="/date-playbook/plans/new">
              <Button size="sm">发起计划</Button>
            </Link>
          </div>
          {state.plans.length === 0 ? (
            <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              还没有计划——发起第一个约会吧
            </p>
          ) : (
            <div className="space-y-3">
              {state.plans.map((plan) => (
                <Link
                  key={plan.id}
                  href={`/date-playbook/plans/${plan.id}`}
                  className="block rounded-lg border p-4 transition-colors hover:border-primary/40 hover:bg-accent/50"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-medium">{plan.title}</h3>
                    <Badge variant={plan.status === "completed" ? "secondary" : "outline"}>
                      {PLAN_STATUS_LABELS[plan.status]}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {plan.date} · 发起人 {plan.createdBy === "user-a" ? "阿关" : "秀秀"}
                    {plan.rejectReason ? ` · 已退回：${plan.rejectReason}` : ""}
                  </p>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
