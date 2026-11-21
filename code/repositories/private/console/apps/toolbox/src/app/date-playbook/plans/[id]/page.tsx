import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@ggbdpq/console-ui";
import { SpaceNav } from "../../space-nav";
import { PlanActions } from "./plan-actions";
import { PLAN_STATUS_LABELS } from "@/schemas/date-playbook";
import { coupleRepo } from "@/server/date-playbook/couple";
import { venueRepo } from "@/server/date-playbook/venues";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const plan = coupleRepo.getPlan(id);
  return { title: plan ? `${plan.title} · 约会计划` : "计划走丢了" };
}

export default async function PlanDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const plan = coupleRepo.getPlan(id);
  if (!plan) notFound();
  const reviews = coupleRepo.listReviews(id);
  const venueNames = plan.venueIds
    .map((vid) => venueRepo.list({}).items.find((v) => v.id === vid)?.name ?? vid)
    .join("、");

  return (
    <div>
      <SpaceNav active="/date-playbook/plans" />
      <header className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">{plan.title}</h1>
          <Badge variant={plan.status === "completed" ? "secondary" : "outline"}>
            {PLAN_STATUS_LABELS[plan.status]}
          </Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {plan.date}
          {plan.startTime ? ` ${plan.startTime}` : ""}
          {plan.endTime ? `–${plan.endTime}` : ""} · 发起人 {plan.createdBy === "user-a" ? "阿关" : "秀秀"}
        </p>
      </header>

      <div className="space-y-4">
        <section className="rounded-lg border p-4">
          <h2 className="mb-2 font-medium">安排</h2>
          <dl className="space-y-1.5 text-sm">
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-muted-foreground">地点</dt>
              <dd>{venueNames}</dd>
            </div>
            {plan.meetingNote ? (
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-muted-foreground">集合</dt>
                <dd>{plan.meetingNote}</dd>
              </div>
            ) : null}
            {plan.estimatedBudget ? (
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-muted-foreground">预算</dt>
                <dd>约 {plan.estimatedBudget} 元</dd>
              </div>
            ) : null}
            {plan.topics.length > 0 ? (
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-muted-foreground">话题</dt>
                <dd>{plan.topics.join("、")}</dd>
              </div>
            ) : null}
            {plan.cautions.length > 0 ? (
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-muted-foreground">注意</dt>
                <dd>{plan.cautions.join("、")}</dd>
              </div>
            ) : null}
            {plan.backupPlan ? (
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-muted-foreground">备用</dt>
                <dd>{plan.backupPlan}</dd>
              </div>
            ) : null}
            {plan.bookingRequired ? (
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-muted-foreground">预约</dt>
                <dd className="text-warning">需要提前预约</dd>
              </div>
            ) : null}
          </dl>
          {plan.rejectReason ? (
            <p className="mt-3 rounded-md bg-muted/60 p-2 text-sm text-muted-foreground">
              上次退回原因：{plan.rejectReason}
            </p>
          ) : null}
        </section>

        <section className="rounded-lg border p-4">
          <h2 className="mb-3 font-medium">下一步</h2>
          <PlanActions planId={plan.id} status={plan.status} createdBy={plan.createdBy} />
          {plan.status === "draft" ? (
            <Link href={`/date-playbook/plans/${plan.id}/edit`} className="mt-2 inline-block text-sm text-primary hover:underline">
              编辑这份草稿 →
            </Link>
          ) : null}
        </section>

        {reviews.length > 0 ? (
          <section className="rounded-lg border p-4">
            <h2 className="mb-3 font-medium">复盘（{reviews.length}）</h2>
            <div className="space-y-3">
              {reviews.map((r) => (
                <div key={r.id} className="rounded-md border p-3 text-sm">
                  <div className="text-xs text-muted-foreground">
                    {r.author === "user-a" ? "阿关" : "秀秀"} · {"★".repeat(r.rating)}
                  </div>
                  {r.highlights ? <p className="mt-1">亮点：{r.highlights}</p> : null}
                  {r.improvements ? <p className="mt-0.5 text-muted-foreground">下次改进：{r.improvements}</p> : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
