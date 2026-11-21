import { describe, expect, it } from "vitest";

import { parseChatImport } from "./chat-import";

describe("parseChatImport", () => {
  it("parses WeChat text blocks with sender and sent time", () => {
    const result = parseChatImport({
      projectId: "project-1",
      sourceName: "群聊.txt",
      contentType: "text/plain",
      content: [
        "2026-06-10 09:15 林然",
        "今晚聚餐有人一起吗？",
        "",
        "2026-06-10 09:16 周宁",
        "@林然 可以，地点定了吗？",
      ].join("\n"),
    });

    expect(result.project.title).toBe("群聊");
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({
      projectId: "project-1",
      senderName: "林然",
      text: "今晚聚餐有人一起吗？",
      sentAt: "2026-06-10T09:15:00.000Z",
      timestampMs: 0,
    });
    expect(result.messages[1]).toMatchObject({
      senderName: "周宁",
      text: "@林然 可以，地点定了吗？",
      timestampMs: 60_000,
    });
  });

  it("parses simple sender colon text when no timestamp header exists", () => {
    const result = parseChatImport({
      projectId: "project-1",
      sourceName: "粘贴文本",
      contentType: "text/plain",
      content: "林然: 今晚聚餐有人一起吗？\n周宁: @林然 可以，地点定了吗？",
    });

    expect(result.messages.map((message) => message.senderName)).toEqual([
      "林然",
      "周宁",
    ]);
    expect(result.messages.map((message) => message.text)).toEqual([
      "今晚聚餐有人一起吗？",
      "@林然 可以，地点定了吗？",
    ]);
  });

  it("parses CSV rows with senderName text and sentAt columns", () => {
    const result = parseChatImport({
      projectId: "project-1",
      sourceName: "群聊.csv",
      contentType: "text/csv",
      content: [
        "senderName,text,sentAt",
        "林然,今晚聚餐有人一起吗？,2026-06-10T09:15:00.000Z",
        "周宁,\"@林然 可以，地点定了吗？\",2026-06-10T09:16:00.000Z",
      ].join("\n"),
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]).toMatchObject({
      senderName: "周宁",
      text: "@林然 可以，地点定了吗？",
      sentAt: "2026-06-10T09:16:00.000Z",
    });
  });

  it("parses JSON arrays with message-like records", () => {
    const result = parseChatImport({
      projectId: "project-1",
      sourceName: "群聊.json",
      contentType: "application/json",
      content: JSON.stringify([
        {
          senderName: "林然",
          text: "今晚聚餐有人一起吗？",
          sentAt: "2026-06-10T09:15:00.000Z",
        },
      ]),
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      projectId: "project-1",
      senderName: "林然",
      text: "今晚聚餐有人一起吗？",
      timestampMs: 0,
    });
  });
});
