import { getInventoryRuntime } from "@/server/inventory/runtime";
import { previewReplenish } from "@ggbdpq/inventory-core";
import { handle } from "@/server/inventory/http";

export async function GET() {
  return handle(() => previewReplenish(getInventoryRuntime().toolkit));
}
