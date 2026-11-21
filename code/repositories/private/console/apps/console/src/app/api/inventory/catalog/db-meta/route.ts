import { readFixtureDbMeta } from "@ggbdpq/inventory-core";
import { handle } from "@/server/inventory/http";

export async function GET() {
  return handle(() => readFixtureDbMeta());
}
