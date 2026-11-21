import { z } from "zod";
import { coupleRepo } from "@/server/date-playbook/couple";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = z
    .object({
      userId: z.string().min(1),
      rating: z.coerce.number().int().min(1).max(5),
      highlights: z.string().default(""),
      improvements: z.string().default(""),
    })
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "参数无效" }, { status: 400 });
  try {
    return Response.json(coupleRepo.submitReview(id, parsed.data.userId, parsed.data));
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "操作失败" }, { status: 400 });
  }
}
