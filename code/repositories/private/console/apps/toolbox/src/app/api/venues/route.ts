import { venueFilterSchema, venueListResponseSchema } from "@/schemas/venue";
import { venueRepo } from "@/server/date-playbook/venues";

export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  const parsed = venueFilterSchema.safeParse({
    category: sp.get("category") ?? undefined,
    scene: sp.get("scene") ?? undefined,
    onlyFavorite: sp.get("favorite") === "1" ? true : undefined,
  });
  if (!parsed.success) {
    return Response.json({ error: "无效筛选参数" }, { status: 400 });
  }
  return Response.json(venueListResponseSchema.parse(venueRepo.list(parsed.data)));
}
