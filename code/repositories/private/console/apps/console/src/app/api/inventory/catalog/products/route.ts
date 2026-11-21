import { readFixtureSearchPage } from "@ggbdpq/inventory-core";
import { handle } from "@/server/inventory/http";

export async function GET() {
  return handle(() => {
    const page = readFixtureSearchPage();
    return {
      totalProducts: page.totalProducts,
      products: page.products,
      shops: page.shops,
    };
  });
}
