import { describe, expect, it } from "vitest";

import type { ChatMessage } from "@/features/chat-viewer/lib/domain/schemas";

import {
  exportMessagesToCsv,
  exportMessagesToJson,
  exportMessagesToMarkdown,
} from "./chat-export";

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
];

describe("chat exports", () => {
  it("exports messages as CSV with quoted text", () => {
    expect(exportMessagesToCsv(messages)).toBe(
      [
        "sentAt,senderName,text",
        '2026-06-10T09:15:00.000Z,林然,今晚聚餐有人一起吗？',
        '2026-06-10T09:16:00.000Z,周宁,"@林然 可以，地点定了吗？"',
      ].join("\n"),
    );
  });

  it("exports messages as pretty JSON", () => {
    const parsed = JSON.parse(exportMessagesToJson(messages)) as ChatMessage[];

    expect(parsed).toEqual(messages);
  });

  it("exports a Markdown report with privacy context and timeline", () => {
    expect(exportMessagesToMarkdown(messages)).toContain(
      "# 微信聊天记录分析报告",
    );
    expect(exportMessagesToMarkdown(messages)).toContain(
      "默认本地处理，不上传聊天内容",
    );
    expect(exportMessagesToMarkdown(messages)).toContain(
      "| 2026-06-10T09:16:00.000Z | 周宁 | @林然 可以，地点定了吗？ |",
    );
  });
});
