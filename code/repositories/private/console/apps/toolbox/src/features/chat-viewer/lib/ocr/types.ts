import type { OcrSegment } from "@/features/chat-viewer/lib/domain/schemas";

/**
 * OCR 引擎的输入图片数据。
 */
export type OcrInput = {
  imageDataUrl: string;
  timestampMs?: number;
};

/**
 * OCR 引擎标准输出结果。
 */
export type OcrResult = {
  engineName: string;
  segments: OcrSegment[];
};

/**
 * 应用对 OCR 引擎的统一抽象。
 */
export interface OcrEngine {
  /**
   * 识别单张图片中的聊天文字片段。
   */
  recognize(input: OcrInput): Promise<OcrResult>;
}
