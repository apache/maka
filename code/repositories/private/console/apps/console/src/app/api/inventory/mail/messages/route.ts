import { createFixtureMailProvider, defaultFixtureInbox } from "@ggbdpq/inventory-core";
import { handle } from "@/server/inventory/http";

export async function GET() {
  return handle(async () => {
    const provider = createFixtureMailProvider(defaultFixtureInbox());
    await provider.connect({ kind: "fixture", mailbox: "inbox@example.com" });
    return provider.listMessages();
  });
}
