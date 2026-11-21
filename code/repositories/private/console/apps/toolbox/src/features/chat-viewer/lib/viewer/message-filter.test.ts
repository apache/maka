import { describe, expect, it } from "vitest";

import type { ChatMessage } from "@/features/chat-viewer/lib/domain/schemas";

import { filterMessages, getMessageParticipants } from "./message-filter";

const messages: ChatMessage[] = [
  {
    id: "message-1",
    projectId: "project-1",
    senderName: "林然",
    text: "今晚聚餐有人一起吗？",
    timestampMs: 0,
    sentAt: "2026-06-10T09:15:00.000Z",
  },
  {
    id: "message-2",
    projectId: "project-1",
    senderName: "周宁",
    text: "@林然 可以，地点定了吗？",
    timestampMs: 60_000,
    sentAt: "2026-06-10T09:16:00.000Z",
  },
  {
    id: "message-3",
    projectId: "project-1",
    senderName: null,
    text: "系统消息",
    timestampMs: 120_000,
    sentAt: "2026-06-11T09:16:00.000Z",
  },
];

describe("filterMessages", () => {
  it("filters by keyword across text and sender name", () => {
    expect(filterMessages(messages, { query: "地点" })).toEqual([messages[1]]);
    expect(filterMessages(messages, { query: "林然" })).toEqual([
      messages[0],
      messages[1],
    ]);
  });

  it("filters by sender name and ISO date", () => {
    expect(
      filterMessages(messages, {
        senderName: "周宁",
        date: "2026-06-10",
      }),
    ).toEqual([messages[1]]);
  });

  it("returns stable participant names without null senders", () => {
    expect(getMessageParticipants(messages)).toEqual(["周宁", "林然"]);
  });
});
