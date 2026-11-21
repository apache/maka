import { describe, expect, it } from "vitest";

import type { ChatMessage } from "@/features/chat-viewer/lib/domain/schemas";

import { getMessageWindow } from "./message-window";

const messages: ChatMessage[] = Array.from({ length: 3 }, (_, index) => ({
  id: `message-${index + 1}`,
  projectId: "project-1",
  senderName: "林然",
  text: `消息 ${index + 1}`,
  timestampMs: index * 1000,
}));

describe("getMessageWindow", () => {
  it("returns a bounded visible window and reports whether more messages exist", () => {
    expect(getMessageWindow(messages, { limit: 2 })).toEqual({
      visibleMessages: messages.slice(0, 2),
      hiddenCount: 1,
      hasMore: true,
    });
  });
});
