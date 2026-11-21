import { z } from "zod";
import { coupleRepo } from "@/server/date-playbook/couple";

const bodySchema = z.object({
  userId: z.string().min(1),
  venueId: z.string().min(1),
  status: z.enum(["want_to_go", "visited", "none"]),
});

/** 源收藏语义：同地点状态互斥，同状态再点即取消 */
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "参数无效" }, { status: 400 });
  try {
    const record = coupleRepo.setFavorite(parsed.data.userId, parsed.data.venueId, parsed.data.status);
    return Response.json({ favorite: record });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "操作失败" }, { status: 400 });
  }
}
