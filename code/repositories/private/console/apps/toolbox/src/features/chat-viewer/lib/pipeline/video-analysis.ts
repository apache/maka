import { buildPersistentAnalysisReport } from "@/features/chat-viewer/lib/analysis/persistent-report";
import type {
  AnalysisReport,
  ChatMessage,
  FrameSample,
  OcrSegment,
} from "@/features/chat-viewer/lib/domain/schemas";
import { mergeOcrSegmentsToMessages } from "@/features/chat-viewer/lib/messages/merge";
import type { OcrEngine } from "@/features/chat-viewer/lib/ocr/types";

/**
 * OCR 管线可以处理的已抽取图片帧。
 */
export type VideoFrameImage = {
  imageDataUrl: string;
  timestampMs: number;
  width: number;
  height: number;
};

/**
 * 视频分析管线进度事件。
 */
export type VideoAnalysisProgressEvent = {
  stage: "ocr" | "merge";
  completedFrames: number;
  totalFrames: number;
};

/**
 * 视频分析管线输入参数。
 */
export type AnalyzeVideoFrameImagesOptions = {
  projectId: string;
  frames: VideoFrameImage[];
  ocrEngine: OcrEngine;
  onProgress?: (event: VideoAnalysisProgressEvent) => void;
};

/**
 * 视频分析管线输出结果。
 */
export type VideoAnalysisResult = {
  frames: FrameSample[];
  messages: ChatMessage[];
  report: AnalysisReport;
};

/**
 * 对已抽取的视频图片帧执行 OCR、消息合并和报告生成。
 */
export async function analyzeVideoFrameImages({
  projectId,
  frames,
  ocrEngine,
  onProgress,
}: AnalyzeVideoFrameImagesOptions): Promise<VideoAnalysisResult> {
  /**
   * 带帧上下文的 OCR 片段，用于后续消息合并。
   */
  const allSegments: Array<
    OcrSegment & {
      id: string;
      frameId: string;
      projectId: string;
      timestampMs: number;
    }
  > = [];

  /**
   * 已完成 OCR 的帧样本集合。
   */
  const analyzedFrames: FrameSample[] = [];

  for (const [frameIndex, frame] of frames.entries()) {
    const frameId = `frame-${frameIndex + 1}`;
    const result = await ocrEngine.recognize({
      imageDataUrl: frame.imageDataUrl,
      timestampMs: frame.timestampMs,
    });

    const segments = result.segments.map((segment, segmentIndex) => ({
      ...segment,
      id: segment.id ?? `${frameId}:ocr-${segmentIndex + 1}`,
      frameId,
      projectId,
      timestampMs: frame.timestampMs,
    }));

    allSegments.push(...segments);
    analyzedFrames.push({
      id: frameId,
      projectId,
      timestampMs: frame.timestampMs,
      imageDataUrl: frame.imageDataUrl,
      ocrSegments: segments,
    });

    onProgress?.({
      stage: "ocr",
      completedFrames: analyzedFrames.length,
      totalFrames: frames.length,
    });
  }

  const messages = mergeOcrSegmentsToMessages(allSegments).map((message, index) => ({
    ...message,
    id: `${projectId}:message-${index + 1}`,
    projectId,
  }));

  onProgress?.({
    stage: "merge",
    completedFrames: frames.length,
    totalFrames: frames.length,
  });

  return {
    frames: analyzedFrames,
    messages,
    report: buildPersistentAnalysisReport(projectId, messages),
  };
}
