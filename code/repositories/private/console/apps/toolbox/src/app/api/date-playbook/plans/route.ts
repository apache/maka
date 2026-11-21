import { z } from "zod";
import { coupleRepo } from "@/server/date-playbook/couple";

// 计划创建：对齐源 datePlanFormSchema 全字段 + submit（提交给对方确认）

const bodySchema = z.object({
  coupleId: z.string().min(1),
  userId: z.string().min(1),
  title: z.string().trim().min(1, "请填写计划名称").max(30, "计划名称最多 30 字"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "请选择日期"),
  venueIds: z.array(z.string()).min(1, "至少选择一个地点"),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  meetingNote: z.string().trim().max(100).optional(),
  estimatedBudget: z.number().min(0).optional(),
  topics: z.array(z.string()).default([]),
  cautions: z.array(z.string()).default([]),
  backupPlan: z.string().trim().max(100).optional(),
  bookingRequired: z.boolean().default(false),
  submit: z.boolean().optional(),
});

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "表单无效" }, { status: 400 });
  const { coupleId, userId, submit, ...form } = parsed.data;
  try {
    return Response.json(coupleRepo.createPlan(coupleId, userId, form, { submit }));
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "操作失败" }, { status: 400 });
  }
}
