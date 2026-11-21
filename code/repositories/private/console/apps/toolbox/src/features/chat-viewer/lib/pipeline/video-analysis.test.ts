import { describe, expect, it } from "vitest";

import type { OcrResult } from "@/features/chat-viewer/lib/ocr/types";
import type { OcrEngine, OcrInput } from "@/features/chat-viewer/lib/ocr/types";

import { analyzeVideoFrameImages } from "./video-analysis";

class ScriptedOcrEngine implements OcrEngine {
  /**
   * 测试用 OCR 引擎按输入顺序返回预设结果。
   */
  constructor(private readonly results: OcrResult[]) {}

  /**
   * 返回当前帧对应的预设 OCR 结果。
   */
  async recognize(input: OcrInput): Promise<OcrResult> {
    const result = this.results.shift();

    if (!result) {
      throw new Error(`No OCR result for ${input.imageDataUrl}`);
    }

    return result;
  }
}

describe("analyzeVideoFrameImages", () => {
  it("runs OCR across frames, merges duplicate messages, and builds a persistent report", async () => {
    const progressEvents: string[] = [];

    const result = await analyzeVideoFrameImages({
      projectId: "project-1",
      frames: [
        {
          imageDataUrl: "data:image/png;base64,frame-1",
          timestampMs: 0,
          width: 1280,
          height: 720,
        },
        {
          imageDataUrl: "data:image/png;base64,frame-2",
          timestampMs: 1_000,
          width: 1280,
          height: 720,
        },
      ],
      ocrEngine: new ScriptedOcrEngine([
        {
          engineName: "scripted",
          segments: [{ text: "林然: 今晚聚餐有人一起吗？", confidence: 0.92 }],
        },
        {
          engineName: "scripted",
          segments: [{ text: "林然: 今晚聚餐有人一起吗？", confidence: 0.88 }],
        },
      ]),
      onProgress: (event) => {
        progressEvents.push(`${event.stage}:${event.completedFrames}/${event.totalFrames}`);
      },
    });

    expect(result.frames).toHaveLength(2);
    expect(result.frames[0].ocrSegments[0]).toMatchObject({
      frameId: "frame-1",
      text: "林然: 今晚聚餐有人一起吗？",
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      projectId: "project-1",
      senderName: "林然",
      text: "今晚聚餐有人一起吗？",
      sourceFrameIds: ["frame-1", "frame-2"],
      confidence: 0.88,
    });
    expect(result.report).toMatchObject({
      projectId: "project-1",
      messageCount: 1,
      participantCount: 1,
      topKeywords: [{ keyword: "聚餐", count: 1 }],
      timeline: [{ timestampMs: 0, messageCount: 1 }],
    });
    expect(progressEvents).toEqual(["ocr:1/2", "ocr:2/2", "merge:2/2"]);
  });
});
