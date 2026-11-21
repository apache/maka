import { z } from "zod";
import { coupleRepo } from "@/server/date-playbook/couple";
import { planStatusSchema } from "@/schemas/date-playbook";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = z
    .object({ userId: z.string().min(1), to: planStatusSchema, reason: z.string().trim().max(100).optional() })
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "参数无效" }, { status: 400 });
  try {
    // 退回草稿必须带原因（源 rejectPlan 交互）
    if (parsed.data.to === "draft" && parsed.data.reason) {
      return Response.json(coupleRepo.rejectPlan(id, parsed.data.userId, parsed.data.reason));
    }
    return Response.json(coupleRepo.transitionPlan(id, parsed.data.userId, parsed.data.to, { reason: parsed.data.reason }));
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "操作失败" }, { status: 400 });
  }
}
