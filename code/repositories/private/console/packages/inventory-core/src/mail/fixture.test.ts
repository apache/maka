import { describe, expect, it } from "vitest";

import { createFixtureMailProvider } from "./fixture";

describe("fixture mail provider", () => {
  it("lists messages from local fixture after connect", async () => {
    const provider = createFixtureMailProvider([
      {
        id: "msg-1",
        subject: "verify code 4821",
        from: { address: "noreply@example.com" },
        date: "2026-08-18T12:00:00.000Z",
      },
    ]);
    await provider.connect({ kind: "fixture", mailbox: "inbox@example.com" });
    const listed = await provider.listMessages();
    expect(provider.name).toBe("fixture");
    expect(listed.messages).toHaveLength(1);
    expect(listed.messages[0]?.subject).toContain("4821");
  });
});
