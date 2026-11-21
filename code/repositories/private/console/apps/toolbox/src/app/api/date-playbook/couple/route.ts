import { z } from "zod";
import { coupleRepo } from "@/server/date-playbook/couple";

const bodySchema = z.object({
  action: z.enum(["create", "join"]),
  userId: z.string().min(1),
  name: z.string().trim().min(1).max(20).optional(),
  inviteCode: z.string().optional(),
});

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "参数无效" }, { status: 400 });
  const { action, userId, name, inviteCode } = parsed.data;
  try {
    if (action === "create") {
      if (!name) return Response.json({ error: "请填写空间名称" }, { status: 400 });
      return Response.json(coupleRepo.createCouple(name, userId));
    }
    if (!inviteCode) return Response.json({ error: "请填写邀请码" }, { status: 400 });
    return Response.json(coupleRepo.joinCouple(inviteCode, userId));
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "操作失败" }, { status: 400 });
  }
}
