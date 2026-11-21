"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Textarea } from "@ggbdpq/console-ui";
import type { Plan } from "@/schemas/date-playbook";
import { useDatePlaybookSession } from "@/stores/date-playbook";

// 计划表单：对齐源 datePlanFormSchema 全字段（title/date/时间/地点/集合/预算/话题/注意/备用/预约）
export function PlanForm({
  coupleId,
  venueOptions,
  plan,
}: {
  coupleId: string;
  venueOptions: Array<{ id: string; name: string }>;
  plan?: Plan;
}) {
  const router = useRouter();
  const currentUserId = useDatePlaybookSession((s) => s.currentUserId);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    title: plan?.title ?? "",
    date: plan?.date ?? "",
    startTime: plan?.startTime ?? "",
    endTime: plan?.endTime ?? "",
    venueIds: plan?.venueIds.join(",") ?? "",
    meetingNote: plan?.meetingNote ?? "",
    estimatedBudget: plan?.estimatedBudget?.toString() ?? "",
    topics: plan?.topics.join(",") ?? "",
    cautions: plan?.cautions.join(",") ?? "",
    backupPlan: plan?.backupPlan ?? "",
    bookingRequired: plan?.bookingRequired ?? false,
  });

  const payload = (submit: boolean) => ({
    userId: currentUserId,
    title: form.title.trim(),
    date: form.date,
    startTime: form.startTime,
    endTime: form.endTime,
    venueIds: form.venueIds.split(/[,，]/).map((v) => v.trim()).filter(Boolean),
    meetingNote: form.meetingNote.trim(),
    estimatedBudget: form.estimatedBudget ? Number(form.estimatedBudget) : undefined,
    topics: form.topics.split(/[,，]/).map((v) => v.trim()).filter(Boolean),
    cautions: form.cautions.split(/[,，]/).map((v) => v.trim()).filter(Boolean),
    backupPlan: form.backupPlan.trim(),
    bookingRequired: form.bookingRequired,
    submit,
  });

  const submit = async (asDraft: boolean) => {
    setBusy(true);
    const url = plan ? `/api/date-playbook/plans/${plan.id}` : "/api/date-playbook/plans";
    const res = await fetch(url, {
      method: plan ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(plan ? payload(asDraft) : { coupleId, ...payload(asDraft) }),
    });
    setBusy(false);
    if (!res.ok) {
      const json = (await res.json()) as { error?: string };
      setError(json.error ?? "提交失败");
      return;
    }
    router.push(plan ? `/date-playbook/plans/${plan.id}` : "/date-playbook/plans");
  };

  const field = "w-full rounded-md border bg-background px-3 py-2 text-sm";

  return (
    <div className="space-y-4">
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1.5">
          <span className="text-sm font-medium">计划名称 *</span>
          <Input value={form.title} maxLength={30} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="最多 30 字" />
        </label>
        <label className="space-y-1.5">
          <span className="text-sm font-medium">日期 *</span>
          <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
        </label>
        <label className="space-y-1.5">
          <span className="text-sm font-medium">开始时间</span>
          <Input type="time" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} />
        </label>
        <label className="space-y-1.5">
          <span className="text-sm font-medium">结束时间</span>
          <Input type="time" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} />
        </label>
      </div>
      <label className="block space-y-1.5">
        <span className="text-sm font-medium">地点 *（可多选，逗号分隔）</span>
        <input
          list="venue-options"
          value={form.venueIds}
          onChange={(e) => setForm({ ...form, venueIds: e.target.value })}
          className={field}
          placeholder="从下方候选选择或输入地点 ID"
        />
        <datalist id="venue-options">
          {venueOptions.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </datalist>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1.5">
          <span className="text-sm font-medium">集合说明</span>
          <Input value={form.meetingNote} maxLength={100} onChange={(e) => setForm({ ...form, meetingNote: e.target.value })} placeholder="如：地铁口见" />
        </label>
        <label className="space-y-1.5">
          <span className="text-sm font-medium">预算（元）</span>
          <Input type="number" min={0} value={form.estimatedBudget} onChange={(e) => setForm({ ...form, estimatedBudget: e.target.value })} />
        </label>
        <label className="space-y-1.5">
          <span className="text-sm font-medium">想聊的话题</span>
          <Input value={form.topics} onChange={(e) => setForm({ ...form, topics: e.target.value })} placeholder="逗号分隔" />
        </label>
        <label className="space-y-1.5">
          <span className="text-sm font-medium">注意事项</span>
          <Input value={form.cautions} onChange={(e) => setForm({ ...form, cautions: e.target.value })} placeholder="逗号分隔" />
        </label>
      </div>
      <label className="block space-y-1.5">
        <span className="text-sm font-medium">备用方案</span>
        <Textarea rows={2} maxLength={100} value={form.backupPlan} onChange={(e) => setForm({ ...form, backupPlan: e.target.value })} placeholder="下雨怎么办" />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.bookingRequired}
          onChange={(e) => setForm({ ...form, bookingRequired: e.target.checked })}
        />
        需要提前预约
      </label>
      <div className="flex justify-end gap-2">
        <Button variant="outline" disabled={busy} onClick={() => void submit(false)}>
          存为草稿
        </Button>
        <Button disabled={busy} onClick={() => void submit(true)}>
          {plan ? "重新提交确认" : "提交给对方确认"}
        </Button>
      </div>
    </div>
  );
}
