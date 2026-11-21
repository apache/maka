import { readFixtureHistoryById } from "@ggbdpq/inventory-core";
import { ApiError, handle } from "@/server/inventory/http";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handle(() => {
    const history = readFixtureHistoryById(id);
    if (!history) {
      throw new ApiError(404, "NOT_FOUND", "历史记录不存在");
    }
    return history;
  });
}
