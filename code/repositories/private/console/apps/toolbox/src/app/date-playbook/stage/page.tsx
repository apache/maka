"use client";
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Input } from "@ggbdpq/console-ui";
import { SpaceNav } from "../space-nav";
import { UserSwitcher } from "../user-switcher";
import { STAGE_DISCLAIMER, STAGE_LABELS, STAGE_ORDER } from "@/features/date-playbook/constants/stage";
import { canProposeStageChange } from "@/features/date-playbook/domain/stage/rules";
import type { RelationshipStage } from "@/features/date-playbook/domain/types";
import { useDatePlaybookSession } from "@/stores/date-playbook";

interface StageProposal {
  id: string;
  coupleId: string;
  proposer: string;
  fromStage: string;
  toStage: string;
  reason: string;
  status: "pending" | "accepted" | "rejected";
  createdAt: string;
}

// 九阶段提案页（源 stage-proposal：只能改非原地阶段、必须填事实依据、对方响应才生效）
export default function StageProposalPage() {
  const currentUserId = useDatePlaybookSession((s) => s.currentUserId);
  const [coupleId, setCoupleId] = useState<string | null>(null);
  const [currentStage, setCurrentStage] = useState<RelationshipStage>("initial_contact");
  const [proposals, setProposals] = useState<StageProposal[]>([]);
  const [toStage, setToStage] = useState<RelationshipStage | "">("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    const stateRes = await fetch(`/api/date-playbook/state?userId=${currentUserId}`);
    const state = (await stateRes.json()) as { couple: { id: string; currentStage?: string } | null };
    if (!state.couple) {
      setCoupleId(null);
      return;
    }
    setCoupleId(state.couple.id);
    setCurrentStage((state.couple.currentStage as RelationshipStage) ?? "initial_contact");
    const listRes = await fetch(`/api/date-playbook/stage-proposals?coupleId=${state.couple.id}`);
    const list = (await listRes.json()) as { items: StageProposal[] };
    setProposals(list.items);
  }, [currentUserId]);

  useEffect(() => {
    void load();
  }, [load]);

  const post = async (body: Record<string, unknown>) => {
    setError("");
    setNotice("");
    const res = await fetch("/api/date-playbook/stage-proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { error?: string };
    if (!res.ok) {
      setError(json.error ?? "操作失败");
      return;
    }
    await load();
  };

  if (coupleId === null) {
    return (
      <div>
        <SpaceNav active="/date-playbook/couple" />
        <UserSwitcher />
        <p className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
          还没有两人空间——先到「我们」页创建或加入后再来推进阶段
        </p>
      </div>
    );
  }

  const nextStage = STAGE_ORDER[Math.min(STAGE_ORDER.indexOf(currentStage) + 1, STAGE_ORDER.length - 1)];

  return (
    <div>
      <SpaceNav active="/date-playbook/couple" />
      <UserSwitcher />
      <header className="mb-6">
        <h1 className="text-3xl font-semibold tracking-tight">关系阶段</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          当前阶段：<span className="font-medium text-foreground">{STAGE_LABELS[currentStage as keyof typeof STAGE_LABELS] ?? "初步认识"}</span>
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{STAGE_DISCLAIMER}</p>
      </header>

      <section className="mb-8">
        <h2 className="mb-3 font-medium">阶段阶梯</h2>
        <div className="flex flex-wrap gap-1.5">
          {STAGE_ORDER.map((stage, i) => (
            <Badge key={stage} variant={stage === currentStage ? "default" : i < STAGE_ORDER.indexOf(currentStage) ? "secondary" : "outline"}>
              {STAGE_LABELS[stage]}
            </Badge>
          ))}
        </div>
      </section>

      <section className="mb-8 rounded-lg border p-4">
        <h2 className="mb-1 font-medium">发起阶段变更提案</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          必须填写一句事实依据；不能原地变更；提案由对方确认后才生效
        </p>
        <div className="flex flex-wrap gap-2">
          <select
            value={toStage}
            onChange={(e) => setToStage(e.target.value as RelationshipStage | "")}
            className="rounded-md border bg-background px-3 py-1.5 text-sm"
          >
            <option value="">选择目标阶段…</option>
            {STAGE_ORDER.filter((s) => canProposeStageChange(currentStage, s)).map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </select>
          <Input
            className="max-w-sm flex-1"
            placeholder={nextStage === currentStage ? "" : `事实依据，如：${STAGE_LABELS[nextStage]}的依据…`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button
            size="sm"
            disabled={!toStage || !reason.trim()}
            onClick={() => void post({ action: "create", coupleId, userId: currentUserId, toStage, reason: reason.trim() })}
          >
            发起提案
          </Button>
        </div>
      </section>

      {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}
      {notice ? <p className="mb-4 text-sm text-success">{notice}</p> : null}

      <section>
        <h2 className="mb-3 font-medium">提案记录</h2>
        {proposals.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            还没有阶段提案
          </p>
        ) : (
          <div className="space-y-3">
            {proposals.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
                <div>
                  <span className="font-medium">{p.proposer === "user-a" ? "阿关" : "秀秀"}</span> 提议：
                  {STAGE_LABELS[p.fromStage as keyof typeof STAGE_LABELS] ?? p.fromStage} →{" "}
                  {STAGE_LABELS[p.toStage as keyof typeof STAGE_LABELS] ?? p.toStage}
                  <span className="ml-2 text-muted-foreground">依据：{p.reason}</span>
                </div>
                {p.status === "pending" ? (
                  p.proposer === currentUserId ? (
                    <Badge variant="outline">等待对方响应</Badge>
                  ) : (
                    <span className="flex gap-2">
                      <Button size="sm" onClick={() => void post({ action: "respond", userId: currentUserId, proposalId: p.id, accept: true })}>
                        同意
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => void post({ action: "respond", userId: currentUserId, proposalId: p.id, accept: false })}>
                        婉拒
                      </Button>
                    </span>
                  )
                ) : (
                  <Badge variant={p.status === "accepted" ? "secondary" : "outline"}>
                    {p.status === "accepted" ? "已生效" : "已婉拒"}
                  </Badge>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
