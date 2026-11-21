import { describe, expect, it } from "vitest";

import type { ChatMessage } from "@/features/chat-viewer/lib/domain/schemas";
import { buildAnalysisReport } from "./analyze";

type AnalyzableMessage = ChatMessage & {
  sourceFrameIds: string[];
  confidence: number;
  tags: string[];
};

describe("buildAnalysisReport", () => {
  it("builds core chat statistics from merged messages", () => {
    const messages: AnalyzableMessage[] = [
      {
        id: "msg-1",
        projectId: "project-1",
        senderName: "小明",
        text: "今晚聚餐吗 @小红",
        timestampMs: Date.UTC(2026, 5, 8, 18, 5),
        frameId: "frame-001",
        sourceFrameIds: ["frame-001"],
        confidence: 0.92,
        tags: [],
      },
      {
        id: "msg-2",
        projectId: "project-1",
        senderName: "小红",
        text: "可以，我叫上小李",
        timestampMs: Date.UTC(2026, 5, 8, 18, 6),
        frameId: "frame-002",
        sourceFrameIds: ["frame-002"],
        confidence: 0.95,
        tags: [],
      },
      {
        id: "msg-3",
        projectId: "project-1",
        senderName: "小李",
        text: "",
        timestampMs: Date.UTC(2026, 5, 8, 19, 1),
        frameId: "frame-003",
        sourceFrameIds: ["frame-003"],
        confidence: 0.8,
        tags: [],
      },
      {
        id: "msg-4",
        projectId: "project-1",
        senderName: "小明",
        text: "聚餐地点定了吗",
        timestampMs: Date.UTC(2026, 5, 8, 18, 20),
        frameId: "frame-004",
        sourceFrameIds: ["frame-004"],
        confidence: 0.63,
        tags: ["low-confidence"],
      },
    ];
    const report = buildAnalysisReport(messages);

    expect(report.totalMessages).toBe(4);
    expect(report.validMessages).toBe(3);
    expect(report.peakHour).toEqual({ hour: 18, count: 3 });
    expect(report.keywords).toContainEqual({ keyword: "聚餐", count: 2 });
    expect(report.speakerRanking).toEqual([
      { senderName: "小明", messageCount: 2 },
      { senderName: "小红", messageCount: 1 },
      { senderName: "小李", messageCount: 1 },
    ]);
    expect(report.mentions).toEqual([{ target: "小红", count: 1 }]);
    expect(report.replyRelations).toEqual([
      { from: "小红", to: "小明", count: 1 },
      { from: "小李", to: "小红", count: 1 },
      { from: "小明", to: "小李", count: 1 },
    ]);
  });
});
