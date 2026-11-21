import { datePlaybookStateSchema } from "@/app/date-playbook/api-client";
import { coupleRepo } from "@/server/date-playbook/couple";

export async function GET(request: Request) {
  const userId = new URL(request.url).searchParams.get("userId") ?? "";
  if (!userId) return Response.json({ error: "缺少 userId" }, { status: 400 });

  const couple = coupleRepo.listCouples().find((c) => c.memberIds.includes(userId)) ?? null;
  const state = {
    couple,
    plans: couple ? coupleRepo.listPlans(couple.id) : [],
    proposals: couple ? coupleRepo.listProposals(couple.id) : [],
    timeline: couple ? coupleRepo.listTimeline(couple.id) : [],
  };
  return Response.json(datePlaybookStateSchema.parse(state));
}
