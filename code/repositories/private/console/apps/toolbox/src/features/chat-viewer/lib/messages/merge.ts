import type { OcrSegment, ChatMessage } from "@/features/chat-viewer/lib/domain/schemas";

/**
 * 合并流程内部使用的 OCR 片段输入结构。
 */
type MergeInput = OcrSegment & {
  id?: string;
  frameId: string;
  projectId?: string;
  text: string;
  confidence: number;
  timestampMs?: number;
};

/**
 * 合并流程内部生成的标准聊天消息结构。
 */
type MergeOutput = ChatMessage & {
  id: string;
  senderName: string;
  text: string;
  sourceFrameIds: string[];
  confidence: number;
  tags: string[];
  sentAt?: string;
};

/**
 * 低置信度标签的判定阈值。
 */
const LOW_CONFIDENCE_THRESHOLD = 0.65;

/**
 * 将 OCR 片段按发送人和文本连续性合并为聊天消息。
 */
export function mergeOcrSegmentsToMessages(
  _segments: OcrSegment[],
): ChatMessage[] {
  /**
   * 将 schema 层片段收窄为合并逻辑需要的字段集合。
   */
  const segments = _segments as MergeInput[];

  /**
   * 累积输出的聊天消息列表。
   */
  const messages: MergeOutput[] = [];

  for (const segment of segments) {
    const parsed = parseSegmentText(segment.text);
    const tags =
      segment.confidence < LOW_CONFIDENCE_THRESHOLD ? ["low-confidence"] : [];
    const previous = messages.at(-1);

    if (
      previous &&
      previous.senderName === parsed.senderName &&
      previous.text === parsed.text
    ) {
      if (!previous.sourceFrameIds.includes(segment.frameId)) {
        previous.sourceFrameIds.push(segment.frameId);
      }
      previous.confidence = Math.min(previous.confidence, segment.confidence);
      previous.tags = Array.from(new Set([...previous.tags, ...tags]));
      continue;
    }

    messages.push({
      id: segment.id ?? `message-${messages.length + 1}`,
      projectId: segment.projectId ?? "unknown-project",
      senderName: parsed.senderName,
      text: parsed.text,
      timestampMs: segment.timestampMs ?? 0,
      frameId: segment.frameId,
      sourceFrameIds: [segment.frameId],
      confidence: segment.confidence,
      tags,
    } as MergeOutput);
  }

  return messages;
}

/**
 * 解析常见的“发送人: 内容”文本格式。
 */
function parseSegmentText(text: string): Pick<MergeOutput, "senderName" | "text"> {
  const trimmed = text.trim();
  const match = trimmed.match(/^([^:：]+)[:：]\s*(.*)$/);

  if (!match) {
    return {
      senderName: "unknown",
      text: trimmed,
    };
  }

  return {
    senderName: match[1].trim(),
    text: match[2].trim(),
  };
}
