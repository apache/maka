import { getInventoryRuntime } from "@/server/inventory/runtime";
import { handle } from "@/server/inventory/http";

export async function POST() {
  return handle(() => getInventoryRuntime().workspace.runAutoReplenish());
}
