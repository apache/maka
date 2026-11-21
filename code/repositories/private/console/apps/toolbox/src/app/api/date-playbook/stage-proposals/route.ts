import { z } from "zod";
import { coupleRepo } from "@/server/date-playbook/couple";

const bodySchema = z.object({
  action: z.enum(["create", "respond"]),
  coupleId: z.string().optional(),
  userId: z.string().min(1),
  toStage: z.string().optional(),
  reason: z.string().optional(),
  proposalId: z.string().optional(),
  accept: z.boolean().optional(),
});

export async function GET(request: Request) {
  const coupleId = new URL(request.url).searchParams.get("coupleId");
  if (!coupleId) return Response.json({ error: "缺少 coupleId" }, { status: 400 });
  return Response.json({ items: coupleRepo.listStageProposals(coupleId) });
}

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "参数无效" }, { status: 400 });
  const { action, coupleId, userId, toStage, reason, proposalId, accept } = parsed.data;
  try {
    if (action === "create") {
      if (!coupleId || !toStage) return Response.json({ error: "缺少 coupleId 或 toStage" }, { status: 400 });
      return Response.json(coupleRepo.createStageProposal(coupleId, userId, toStage, reason ?? ""));
    }
    if (!proposalId || typeof accept !== "boolean") return Response.json({ error: "缺少 proposalId 或 accept" }, { status: 400 });
    return Response.json(coupleRepo.respondStageProposal(proposalId, userId, accept));
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "操作失败" }, { status: 400 });
  }
}
