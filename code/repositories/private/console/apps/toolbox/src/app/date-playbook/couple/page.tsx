"use client";
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Input } from "@ggbdpq/console-ui";
import { STAGE_LABELS, STAGE_ORDER, type Proposal } from "@/schemas/date-playbook";
import { datePlaybookStateSchema, type DatePlaybookState } from "../api-client";
import { SpaceNav } from "../space-nav";
import { UserSwitcher } from "../user-switcher";
import { useDatePlaybookSession, DEMO_USERS } from "@/stores/date-playbook";

const userName = (id: string) => DEMO_USERS.find((u) => u.id === id)?.name ?? id;

export default function CouplePage() {
  const { currentUserId, setCouple } = useDatePlaybookSession();
  const [state, setState] = useState<DatePlaybookState | null>(null);
  const [name, setName] = useState("");
  const [invite, setInvite] = useState("");
  const [stage, setStage] = useState<string>(STAGE_ORDER[1]);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const res = await fetch(`/api/date-playbook/state?userId=${currentUserId}`);
    setState(datePlaybookStateSchema.parse(await res.json()));
  }, [currentUserId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setCouple(state?.couple?.id ?? null);
  }, [state, setCouple]);

  const post = async (url: string, body: unknown) => {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json()) as { error?: string };
    if (!res.ok) setError(json.error ?? "操作失败");
    else {
      setError("");
      await load();
    }
  };

  const couple = state?.couple;
  const pendingProposals = state?.proposals.filter((p) => p.status === "pending") ?? [];

  return (
    <div>
      <SpaceNav active="/date-playbook/couple" />
      <UserSwitcher />
      {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}

      {!couple ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border p-5">
            <h2 className="font-medium">创建两人空间</h2>
            <Input className="mt-3" placeholder="空间名称" value={name} onChange={(e) => setName(e.target.value)} />
            <Button
              className="mt-3"
              size="sm"
              onClick={() => void post("/api/date-playbook/couple", { action: "create", userId: currentUserId, name: name.trim() })}
            >
              创建（我是发起方）
            </Button>
          </div>
          <div className="rounded-lg border p-5">
            <h2 className="font-medium">加入对方的空间</h2>
            <Input className="mt-3" placeholder="六位数字邀请码" value={invite} onChange={(e) => setInvite(e.target.value)} />
            <Button
              className="mt-3"
              size="sm"
              variant="outline"
              onClick={() => void post("/api/date-playbook/couple", { action: "join", userId: currentUserId, inviteCode: invite.trim() })}
            >
              加入
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          <section className="rounded-lg border p-5">
            <h2 className="text-lg font-semibold">{couple.name}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              成员：{couple.memberIds.map(userName).join(" & ")} · 邀请码
              <span className="ml-1 font-mono font-medium text-foreground">{couple.inviteCode}</span>
              （切换演示身份后用邀请码加入）
            </p>
          </section>

          <section className="rounded-lg border p-5">
            <h3 className="font-medium">发起阶段推进提案</h3>
            <p className="mt-1 text-xs text-muted-foreground">必须填写一句事实依据，且只能由对方确认生效</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <select value={stage} onChange={(e) => setStage(e.target.value)} className="rounded-md border bg-background px-3 py-1.5 text-sm">
                {STAGE_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {STAGE_LABELS[s]}
                  </option>
                ))}
              </select>
              <Input className="max-w-sm flex-1" placeholder="事实依据，如：这周末一起过了生日" value={reason} onChange={(e) => setReason(e.target.value)} />
              <Button
                size="sm"
                onClick={() => void post("/api/date-playbook/proposals", { action: "create", coupleId: couple.id, userId: currentUserId, toStage: stage, reason })}
              >
                发起提案
              </Button>
            </div>
          </section>

          {pendingProposals.length > 0 ? (
            <section className="rounded-lg border p-5">
              <h3 className="font-medium">待响应提案</h3>
              <div className="mt-3 space-y-3">
                {pendingProposals.map((p: Proposal) => (
                  <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
                    <span>
                      <span className="font-medium">{userName(p.proposer)}</span> 提议推进到「
                      {STAGE_LABELS[p.toStage]}」——{p.reason}
                    </span>
                    {p.proposer === currentUserId ? (
                      <Badge variant="outline">等待对方响应</Badge>
                    ) : (
                      <span className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => void post("/api/date-playbook/proposals", { action: "respond", userId: currentUserId, proposalId: p.id, accept: true })}
                        >
                          同意
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void post("/api/date-playbook/proposals", { action: "respond", userId: currentUserId, proposalId: p.id, accept: false })}
                        >
                          婉拒
                        </Button>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
