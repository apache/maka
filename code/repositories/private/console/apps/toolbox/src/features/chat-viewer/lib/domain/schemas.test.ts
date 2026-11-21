import { describe, expect, it } from "vitest";

import {
  AnalysisReportSchema,
  ChatMessageSchema,
  FrameSampleSchema,
  OcrSegmentSchema,
  VideoProjectSchema,
} from "./schemas";

describe("domain schemas", () => {
  it("accepts a valid video project", () => {
    const project = VideoProjectSchema.parse({
      id: "project-1",
      title: "May chat review",
      videoFileName: "wechat.mp4",
      videoDurationMs: 120_000,
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:10:00.000Z",
    });

    expect(project.videoDurationMs).toBe(120_000);
  });

  it("accepts a frame sample with OCR segments", () => {
    const frame = FrameSampleSchema.parse({
      id: "frame-1",
      projectId: "project-1",
      timestampMs: 42_000,
      imageDataUrl: "data:image/png;base64,abc",
      ocrSegments: [
        {
          text: "hello",
          confidence: 0.75,
          boundingBox: { x: 10, y: 20, width: 120, height: 32 },
        },
      ],
    });

    expect(frame.ocrSegments).toHaveLength(1);
  });

  it("bounds OCR segment confidence between 0 and 1", () => {
    expect(OcrSegmentSchema.parse({ text: "low", confidence: 0 }).confidence).toBe(
      0,
    );
    expect(OcrSegmentSchema.parse({ text: "high", confidence: 1 }).confidence).toBe(
      1,
    );
    expect(() =>
      OcrSegmentSchema.parse({ text: "too low", confidence: -0.01 }),
    ).toThrow();
    expect(() =>
      OcrSegmentSchema.parse({ text: "too high", confidence: 1.01 }),
    ).toThrow();
  });

  it("preserves OCR segment identity fields when present", () => {
    const segment = OcrSegmentSchema.parse({
      id: "ocr-1",
      frameId: "frame-1",
      text: "Alice: hello",
      confidence: 0.88,
    });

    expect(segment).toMatchObject({
      id: "ocr-1",
      frameId: "frame-1",
    });
  });

  it("allows chat message senderName to be null", () => {
    const message = ChatMessageSchema.parse({
      id: "message-1",
      projectId: "project-1",
      senderName: null,
      text: "Shared without a resolved sender",
      timestampMs: 52_000,
      frameId: "frame-1",
    });

    expect(message.senderName).toBeNull();
  });

  it("accepts merged chat message fields", () => {
    const message = ChatMessageSchema.parse({
      id: "message-1",
      projectId: "project-1",
      senderName: "Alice",
      text: "hello",
      timestampMs: 1_000,
      sourceFrameIds: ["frame-1"],
      confidence: 0.8,
      tags: ["low-confidence"],
      sentAt: "2026-06-09T00:20:00.000Z",
    });

    expect(message.sourceFrameIds).toEqual(["frame-1"]);
  });

  it("accepts an analysis report", () => {
    const report = AnalysisReportSchema.parse({
      projectId: "project-1",
      generatedAt: "2026-06-09T00:20:00.000Z",
      messageCount: 2,
      participantCount: 1,
      topKeywords: [{ keyword: "coffee", count: 2 }],
      timeline: [{ timestampMs: 52_000, messageCount: 2 }],
    });

    expect(report.topKeywords[0]?.keyword).toBe("coffee");
  });
});
