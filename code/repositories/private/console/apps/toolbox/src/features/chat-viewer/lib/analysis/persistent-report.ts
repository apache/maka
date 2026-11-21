import type { AnalysisReport, ChatMessage } from "@/features/chat-viewer/lib/domain/schemas";

/**
 * 持久化报告中优先识别的群聊关键词。
 */
const KEYWORD_PATTERNS = [/聚餐/g, /地点/g, /投票/g, /公告/g, /迟到/g, /位置/g];

/**
 * 根据标准聊天消息生成可持久化的分析报告。
 */
export function buildPersistentAnalysisReport(
  projectId: string,
  messages: ChatMessage[],
  generatedAt = new Date().toISOString(),
): AnalysisReport {
  /**
   * 非空发送人集合，用于统计参与成员数。
   */
  const participants = new Set(
    messages
      .map((message) => message.senderName?.trim())
      .filter((senderName): senderName is string => Boolean(senderName)),
  );

  return {
    projectId,
    generatedAt,
    messageCount: messages.length,
    participantCount: participants.size,
    topKeywords: buildTopKeywords(messages),
    timeline: buildTimeline(messages),
  };
}

/**
 * 从消息正文中抽取并统计核心关键词。
 */
function buildTopKeywords(messages: ChatMessage[]): AnalysisReport["topKeywords"] {
  /**
   * 关键词到出现次数的聚合表。
   */
  const counts = new Map<string, number>();

  for (const message of messages) {
    for (const pattern of KEYWORD_PATTERNS) {
      const matches = message.text.match(pattern) ?? [];

      for (const keyword of matches) {
        counts.set(keyword, (counts.get(keyword) ?? 0) + 1);
      }
    }
  }

  return [...counts.entries()]
    .map(([keyword, count]) => ({ keyword, count }))
    .sort(
      (left, right) =>
        right.count - left.count || left.keyword.localeCompare(right.keyword),
    );
}

/**
 * 按消息相对时间聚合时间线。
 */
function buildTimeline(messages: ChatMessage[]): AnalysisReport["timeline"] {
  /**
   * 相对时间到消息数量的聚合表。
   */
  const counts = new Map<number, number>();

  for (const message of messages) {
    counts.set(message.timestampMs, (counts.get(message.timestampMs) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([timestampMs, messageCount]) => ({ timestampMs, messageCount }))
    .sort((left, right) => left.timestampMs - right.timestampMs);
}
