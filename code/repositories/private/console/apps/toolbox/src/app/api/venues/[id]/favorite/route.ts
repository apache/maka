import { favoriteResponseSchema } from "@/schemas/venue";
import { venueRepo } from "@/server/date-playbook/venues";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const favorite = venueRepo.toggleFavorite(id);
    return Response.json(favoriteResponseSchema.parse({ id, favorite }));
  } catch {
    return Response.json({ error: "地点不存在" }, { status: 404 });
  }
}
