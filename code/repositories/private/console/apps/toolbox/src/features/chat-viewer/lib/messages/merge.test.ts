import { describe, expect, it } from "vitest";

import type { OcrSegment } from "@/features/chat-viewer/lib/domain/schemas";
import { mergeOcrSegmentsToMessages } from "./merge";

type OcrSegmentWithFrame = OcrSegment & {
  id: string;
  frameId: string;
};

describe("mergeOcrSegmentsToMessages", () => {
  it("deduplicates adjacent frames with the same parsed message", () => {
    const segments: OcrSegmentWithFrame[] = [
      {
        id: "ocr-1",
        frameId: "frame-001",
        text: "小明: 今晚聚餐吗",
        confidence: 0.92,
      },
      {
        id: "ocr-2",
        frameId: "frame-002",
        text: "小明: 今晚聚餐吗",
        confidence: 0.88,
      },
      {
        id: "ocr-3",
        frameId: "frame-003",
        text: "小红: 可以",
        confidence: 0.95,
      },
    ];
    const messages = mergeOcrSegmentsToMessages(segments);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      senderName: "小明",
      text: "今晚聚餐吗",
      sourceFrameIds: ["frame-001", "frame-002"],
    });
    expect(messages[1]).toMatchObject({
      senderName: "小红",
      text: "可以",
      sourceFrameIds: ["frame-003"],
    });
  });

  it("marks messages with low OCR confidence", () => {
    const segments: OcrSegmentWithFrame[] = [
      {
        id: "ocr-1",
        frameId: "frame-001",
        text: "小明: 我可能晚点到",
        confidence: 0.64,
      },
    ];
    const messages = mergeOcrSegmentsToMessages(segments);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      senderName: "小明",
      text: "我可能晚点到",
      tags: ["low-confidence"],
    });
  });
});
