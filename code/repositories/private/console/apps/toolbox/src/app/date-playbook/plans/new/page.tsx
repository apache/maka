"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { SpaceNav } from "../../space-nav";
import { UserSwitcher } from "../../user-switcher";
import { PlanForm } from "../plan-form";
import { useDatePlaybookSession } from "@/stores/date-playbook";
import { venueListResponseSchema } from "@/schemas/venue";

export default function NewPlanPage() {
  const currentUserId = useDatePlaybookSession((s) => s.currentUserId);
  const [coupleId, setCoupleId] = useState<string | null>(null);
  const [venues, setVenues] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const [stateRes, venuesRes] = await Promise.all([
        fetch(`/api/date-playbook/state?userId=${currentUserId}`),
        fetch("/api/venues"),
      ]);
      const state = (await stateRes.json()) as { couple: { id: string } | null };
      setCoupleId(state.couple?.id ?? null);
      setVenues(venueListResponseSchema.parse(await venuesRes.json()).items.map((v) => ({ id: v.id, name: v.name })));
      setLoading(false);
    })();
  }, [currentUserId]);

  return (
    <div>
      <SpaceNav active="/date-playbook/plans" />
      <UserSwitcher />
      <header className="mb-6">
        <h1 className="text-3xl font-semibold tracking-tight">发起约会计划</h1>
        <p className="mt-1 text-sm text-muted-foreground">草稿可反复编辑；提交后需对方确认</p>
      </header>
      {loading ? (
        <p className="text-sm text-muted-foreground">加载中…</p>
      ) : !coupleId ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="text-muted-foreground">还没有两人空间，先创建或加入</p>
          <Link href="/date-playbook/couple" className="mt-3 inline-block text-primary hover:underline">
            去创建空间 →
          </Link>
        </div>
      ) : (
        <PlanForm coupleId={coupleId} venueOptions={venues} />
      )}
    </div>
  );
}
