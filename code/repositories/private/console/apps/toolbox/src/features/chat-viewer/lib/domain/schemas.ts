import { z } from "zod";

/**
 * OCR 文本块在图片中的边界盒结构。
 */
export const BoundingBoxSchema = z.object({
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  width: z.number().positive(),
  height: z.number().positive(),
});

/**
 * 通用裁剪区域结构，允许宽高为 0 以表达空区域。
 */
export const RectSchema = z.object({
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});

/**
 * OCR 引擎输出的单段文字识别结果。
 */
export const OcrSegmentSchema = z.object({
  id: z.string().min(1).optional(),
  frameId: z.string().min(1).optional(),
  text: z.string(),
  confidence: z.number().min(0).max(1),
  boundingBox: BoundingBoxSchema.optional(),
});

/**
 * 单个录屏分析项目的元数据。
 */
export const VideoProjectSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  videoFileName: z.string().min(1),
  videoDurationMs: z.number().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/**
 * 从录屏抽取出的单帧图片及其 OCR 结果。
 */
export const FrameSampleSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  timestampMs: z.number().nonnegative(),
  imageDataUrl: z.string().min(1),
  ocrSegments: z.array(OcrSegmentSchema).default([]),
});

/**
 * 合并后的聊天消息结构。
 */
export const ChatMessageSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  senderName: z.string().min(1).nullable(),
  text: z.string(),
  timestampMs: z.number().nonnegative(),
  frameId: z.string().min(1).optional(),
  sourceFrameIds: z.array(z.string().min(1)).optional(),
  confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string().min(1)).optional(),
  sentAt: z.string().datetime().optional(),
});

/**
 * 持久化分析报告的结构。
 */
export const AnalysisReportSchema = z.object({
  projectId: z.string().min(1),
  generatedAt: z.string().datetime(),
  messageCount: z.number().int().nonnegative(),
  participantCount: z.number().int().nonnegative(),
  topKeywords: z.array(
    z.object({
      keyword: z.string().min(1),
      count: z.number().int().nonnegative(),
    }),
  ),
  timeline: z.array(
    z.object({
      timestampMs: z.number().nonnegative(),
      messageCount: z.number().int().nonnegative(),
    }),
  ),
});

/**
 * OCR 文本块边界盒类型。
 */
export type BoundingBox = z.infer<typeof BoundingBoxSchema>;

/**
 * 图片裁剪区域类型。
 */
export type Rect = z.infer<typeof RectSchema>;

/**
 * OCR 单段文字识别结果类型。
 */
export type OcrSegment = z.infer<typeof OcrSegmentSchema>;

/**
 * 录屏分析项目元数据类型。
 */
export type VideoProject = z.infer<typeof VideoProjectSchema>;

/**
 * 录屏抽帧结果类型。
 */
export type FrameSample = z.infer<typeof FrameSampleSchema>;

/**
 * 合并后的聊天消息类型。
 */
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/**
 * 持久化分析报告类型。
 */
export type AnalysisReport = z.infer<typeof AnalysisReportSchema>;
