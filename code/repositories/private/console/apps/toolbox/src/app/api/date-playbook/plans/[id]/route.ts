import { z } from "zod";
import { coupleRepo } from "@/server/date-playbook/couple";

const updateSchema = z.object({
  userId: z.string().min(1),
  title: z.string().trim().min(1).max(30),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  venueIds: z.array(z.string()).min(1),
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

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "表单无效" }, { status: 400 });
  const { userId, submit, ...form } = parsed.data;
  try {
    return Response.json(coupleRepo.updatePlan(id, userId, form, { submit }));
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "操作失败" }, { status: 400 });
  }
}
