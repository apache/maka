import { getInventoryRuntime } from "@/server/inventory/runtime";
import { handle } from "@/server/inventory/http";

export async function GET(req: Request) {
  const query = new URL(req.url).searchParams;
  return handle(() =>
    getInventoryRuntime().workspace.orders(
      query.get("status") ?? "all",
      query.get("query") ?? "",
    ),
  );
}
