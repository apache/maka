import type { ChatMessage } from "@/features/chat-viewer/lib/domain/schemas";

/**
 * 分析模块内部使用的标准化消息结构。
 */
type AnalysisMessage = ChatMessage & {
  id: string;
  senderName: string | null;
  text: string;
  sourceFrameIds: string[];
  confidence: number;
  tags: string[];
};

/**
 * 发言排行中的单个成员统计项。
 */
type RankingItem = {
  senderName: string;
  messageCount: number;
};

/**
 * 通用关键词计数项。
 */
type CountItem = {
  keyword: string;
  count: number;
};

/**
 * 群聊 @ 提及统计项。
 */
type MentionItem = {
  target: string;
  count: number;
};

/**
 * 相邻消息推导出的回复关系统计项。
 */
type ReplyRelation = {
  from: string;
  to: string;
  count: number;
};

/**
 * 工作台展示所需的群聊分析报告。
 */
export type AnalysisReport = {
  totalMessages: number;
  validMessages: number;
  peakHour: { hour: number; count: number } | null;
  keywords: CountItem[];
  speakerRanking: RankingItem[];
  mentions: MentionItem[];
  replyRelations: ReplyRelation[];
};

/**
 * 关键词统计时过滤的低价值词集合。
 */
const STOP_WORDS = new Set([
  "\u53ef\u4ee5",
  "\u4eca\u665a",
  "\u5730\u70b9",
  "\u4e86\u5417",
  "\u6211",
  "\u4e0a",
]);

/**
 * 当前 demo 阶段用于提取业务关键词的模式集合。
 */
const KEYWORD_PATTERNS = [/\u805a\u9910/g];

/**
 * 从消息正文中提取 @ 成员名的正则表达式。
 */
const MENTION_PATTERN = /@([\p{Script=Han}\p{Letter}\p{Number}_-]+)/gu;

/**
 * 根据聊天消息生成活跃度、关键词、成员排行和互动关系报告。
 */
export function buildAnalysisReport(_messages: ChatMessage[]): AnalysisReport {
  /**
   * 将外部 schema 消息收窄为分析流程需要的稳定字段集合。
   */
  const messages = _messages as AnalysisMessage[];

  /**
   * 去掉空文本后用于关键词等内容类统计的消息集合。
   */
  const validMessages = messages.filter((message) => message.text.trim() !== "");

  return {
    totalMessages: messages.length,
    validMessages: validMessages.length,
    peakHour: buildPeakHour(messages),
    keywords: buildKeywords(validMessages),
    speakerRanking: buildSpeakerRanking(messages),
    mentions: buildMentions(messages),
    replyRelations: buildReplyRelations(messages),
  };
}

/**
 * 统计消息量最高的 UTC 小时。
 */
function buildPeakHour(
  messages: AnalysisMessage[],
): AnalysisReport["peakHour"] {
  /**
   * 按小时聚合消息数量的临时索引。
   */
  const hourCounts = new Map<number, number>();

  for (const message of messages) {
    if (typeof message.timestampMs !== "number") {
      continue;
    }

    const hour = new Date(message.timestampMs).getUTCHours();
    hourCounts.set(hour, (hourCounts.get(hour) ?? 0) + 1);
  }

  return [...hourCounts.entries()]
    .sort(([leftHour, leftCount], [rightHour, rightCount]) => {
      if (rightCount !== leftCount) {
        return rightCount - leftCount;
      }

      return leftHour - rightHour;
    })
    .map(([hour, count]) => ({ hour, count }))[0] ?? null;
}

/**
 * 按关键词模式扫描消息文本并输出命中次数。
 */
function buildKeywords(messages: AnalysisMessage[]): CountItem[] {
  /**
   * 关键词到出现次数的聚合表。
   */
  const counts = new Map<string, number>();

  for (const message of messages) {
    for (const pattern of KEYWORD_PATTERNS) {
      const matches = message.text.match(pattern) ?? [];

      for (const keyword of matches) {
        if (!STOP_WORDS.has(keyword)) {
          counts.set(keyword, (counts.get(keyword) ?? 0) + 1);
        }
      }
    }
  }

  return [...counts.entries()]
    .map(([keyword, count]) => ({ keyword, count }))
    .sort((left, right) => right.count - left.count);
}

/**
 * 按发送人统计消息数量并降序排序。
 */
function buildSpeakerRanking(messages: AnalysisMessage[]): RankingItem[] {
  /**
   * 发送人到消息数量的聚合表。
   */
  const counts = new Map<string, number>();

  for (const message of messages) {
    const senderName = normalizeSenderName(message.senderName);
    counts.set(senderName, (counts.get(senderName) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([senderName, messageCount]) => ({ senderName, messageCount }))
    .sort((left, right) => right.messageCount - left.messageCount);
}

/**
 * 提取消息中的 @ 提及对象并按次数排序。
 */
function buildMentions(messages: AnalysisMessage[]): MentionItem[] {
  /**
   * 被提及成员到提及次数的聚合表。
   */
  const counts = new Map<string, number>();

  for (const message of messages) {
    for (const match of message.text.matchAll(MENTION_PATTERN)) {
      const target = match[1];
      counts.set(target, (counts.get(target) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([target, count]) => ({ target, count }))
    .sort((left, right) => right.count - left.count);
}

/**
 * 根据相邻消息的发送者变化推导可能的回复关系。
 */
function buildReplyRelations(messages: AnalysisMessage[]): ReplyRelation[] {
  /**
   * 由 from/to 组合键映射到回复关系统计项。
   */
  const counts = new Map<string, ReplyRelation>();

  for (let index = 1; index < messages.length; index += 1) {
    const previous = messages[index - 1];
    const current = messages[index];

    const previousSenderName = normalizeSenderName(previous.senderName);
    const currentSenderName = normalizeSenderName(current.senderName);

    if (previousSenderName === currentSenderName) {
      continue;
    }

    const key = `${currentSenderName}\u0000${previousSenderName}`;
    const relation = counts.get(key) ?? {
      from: currentSenderName,
      to: previousSenderName,
      count: 0,
    };
    relation.count += 1;
    counts.set(key, relation);
  }

  return [...counts.values()];
}

/**
 * 将缺失或空白的发送人名称归一化为 unknown。
 */
function normalizeSenderName(senderName: string | null): string {
  return senderName?.trim() || "unknown";
}
