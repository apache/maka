import { notFound } from "next/navigation";
import { SpaceNav } from "../../../space-nav";
import { UserSwitcher } from "../../../user-switcher";
import { PlanForm } from "../../plan-form";
import { coupleRepo } from "@/server/date-playbook/couple";
import { venueRepo } from "@/server/date-playbook/venues";

export default async function EditPlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const plan = coupleRepo.getPlan(id);
  if (!plan) notFound();
  if (plan.status !== "draft") {
    return (
      <div>
        <SpaceNav active="/date-playbook/plans" />
        <p className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
          只有草稿状态的计划可以编辑（当前：{plan.status === "pending_confirmation" ? "待确认" : plan.status}）
        </p>
      </div>
    );
  }
  const couple = coupleRepo.getCouple(plan.coupleId);

  return (
    <div>
      <SpaceNav active="/date-playbook/plans" />
      <UserSwitcher />
      <header className="mb-6">
        <h1 className="text-3xl font-semibold tracking-tight">编辑计划</h1>
        <p className="mt-1 text-sm text-muted-foreground">{couple.name}</p>
      </header>
      <PlanForm
        coupleId={couple.id}
        plan={plan}
        venueOptions={venueRepo.list({}).items.map((v) => ({ id: v.id, name: v.name }))}
      />
    </div>
  );
}
