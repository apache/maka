"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@ggbdpq/console-ui";
import { PLAN_STATUS_LABELS, type PlanStatus } from "@/schemas/date-playbook";
import { useDatePlaybookSession } from "@/stores/date-playbook";

/** 状态流转动作 + 退回原因（源 rejectPlan 交互：退回必须填原因） */
export function PlanActions({ planId, status, createdBy }: { planId: string; status: PlanStatus; createdBy: string }) {
  const router = useRouter();
  const currentUserId = useDatePlaybookSession((s) => s.currentUserId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const isMine = createdBy === currentUserId;

  const act = async (to: PlanStatus, withReason?: string) => {
    setBusy(true);
    setError("");
    const res = await fetch(`/api/date-playbook/plans/${planId}/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: currentUserId, to, reason: withReason }),
    });
    setBusy(false);
    if (!res.ok) {
      const json = (await res.json()) as { error?: string };
      setError(json.error ?? "操作失败");
      return;
    }
    setRejecting(false);
    router.refresh();
  };

  const actions: Array<{ to: PlanStatus; label: string }> =
    status === "draft"
      ? [
          { to: "pending_confirmation", label: "提交确认" },
          { to: "cancelled", label: "取消" },
        ]
      : status === "pending_confirmation"
        ? isMine
          ? [{ to: "cancelled", label: "取消" }]
          : [
              { to: "confirmed", label: "确认赴约" },
              { to: "cancelled", label: "取消" },
            ]
        : status === "confirmed"
          ? [
              { to: "completed", label: "完成约会" },
              { to: "cancelled", label: "取消" },
            ]
          : [];

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {actions.map((a) =>
          a.to === "draft" ? null : (
            <Button
              key={a.to}
              size="sm"
              variant={a.to === "cancelled" ? "outline" : "default"}
              disabled={busy}
              onClick={() => void act(a.to)}
            >
              {a.label}
            </Button>
          ),
        )}
        {status === "pending_confirmation" && !isMine ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setRejecting(!rejecting)}>
            退回修改
          </Button>
        ) : null}
        {status === "completed" ? (
          <Link
            href={`/date-playbook/plans/${planId}/review`}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
          >
            写复盘
          </Link>
        ) : null}
      </div>
      {rejecting ? (
        <div className="mt-3 flex gap-2">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="退回原因（必填）"
            className="flex-1 rounded-md border bg-background px-3 py-1.5 text-sm"
          />
          <Button size="sm" disabled={!reason.trim() || busy} onClick={() => void act("draft", reason.trim())}>
            确认退回
          </Button>
        </div>
      ) : null}
      {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
      <p className="mt-2 text-xs text-muted-foreground">当前状态：{PLAN_STATUS_LABELS[status]}</p>
    </div>
  );
}
