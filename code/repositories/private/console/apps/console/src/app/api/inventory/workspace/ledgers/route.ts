import { getInventoryRuntime } from "@/server/inventory/runtime";
import { handle } from "@/server/inventory/http";

export async function GET() {
  return handle(() => ({ ledgers: getInventoryRuntime().workspace.ledgers() }));
}
