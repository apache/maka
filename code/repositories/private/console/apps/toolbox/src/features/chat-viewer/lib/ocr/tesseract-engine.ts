import type { OcrSegment } from "@/features/chat-viewer/lib/domain/schemas";
import type * as Tesseract from "tesseract.js";

import type { OcrEngine, OcrInput, OcrResult } from "./types";

/**
 * 动态导入后的 tesseract.js 模块类型。
 */
type TesseractModule = typeof Tesseract;

/**
 * 创建 Tesseract OCR 引擎时的配置项。
 */
export type TesseractOcrEngineOptions = {
  language?: string;
  workerOptions?: Partial<Tesseract.WorkerOptions>;
};

/**
 * 基于 tesseract.js 的 OCR 引擎实现。
 */
export class TesseractOcrEngine implements OcrEngine {
  /**
   * Tesseract worker 使用的识别语言。
   */
  private readonly language: string;

  /**
   * 透传给 tesseract.js worker 的运行参数。
   */
  private readonly workerOptions?: Partial<Tesseract.WorkerOptions>;

  /**
   * 初始化 Tesseract OCR 引擎配置。
   */
  constructor(options: TesseractOcrEngineOptions = {}) {
    this.language = options.language ?? "chi_sim+eng";
    this.workerOptions = options.workerOptions;
  }

  /**
   * 识别图片并转换为应用内部的 OCR 片段列表。
   */
  async recognize(input: OcrInput): Promise<OcrResult> {
    const { createWorker } = (await import("tesseract.js")) as TesseractModule;
    const worker = await createWorker(this.language, undefined, this.workerOptions);

    try {
      const result = await worker.recognize(input.imageDataUrl);

      return {
        engineName: "tesseract",
        segments: toSegments(result.data),
      };
    } finally {
      await worker.terminate();
    }
  }
}

/**
 * 将 Tesseract 页面结果转换为标准 OCR 片段。
 */
function toSegments(page: Tesseract.Page): OcrSegment[] {
  if (!page.blocks) {
    return page.text.trim()
      ? [{ text: page.text.trim(), confidence: normalizeConfidence(page.confidence) }]
      : [];
  }

  return page.blocks
    .flatMap((block) => block.paragraphs)
    .flatMap((paragraph) => paragraph.lines)
    .filter((line) => line.text.trim().length > 0)
    .map((line) => ({
      text: line.text.trim(),
      confidence: normalizeConfidence(line.confidence),
      boundingBox: {
        x: line.bbox.x0,
        y: line.bbox.y0,
        width: line.bbox.x1 - line.bbox.x0,
        height: line.bbox.y1 - line.bbox.y0,
      },
    }));
}

/**
 * 将 Tesseract 的置信度归一化到 0 到 1。
 */
function normalizeConfidence(confidence: number): number {
  const normalized = confidence > 1 ? confidence / 100 : confidence;

  return Math.min(1, Math.max(0, normalized));
}
