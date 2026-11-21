import type { ChatMessage } from "@/features/chat-viewer/lib/domain/schemas";

/**
 * 消息查看器支持的筛选条件。
 */
export type MessageFilter = {
  query?: string;
  senderName?: string;
  date?: string;
};

/**
 * 根据关键词、发送人和日期筛选消息列表。
 */
export function filterMessages(
  messages: ChatMessage[],
  filter: MessageFilter,
): ChatMessage[] {
  /**
   * 归一化后的全文搜索关键词。
   */
  const query = filter.query?.trim().toLowerCase() ?? "";

  /**
   * 归一化后的发送人筛选值。
   */
  const senderName = filter.senderName?.trim() ?? "";

  /**
   * 日期筛选值使用 input[type=date] 的 yyyy-MM-dd 格式。
   */
  const date = filter.date?.trim() ?? "";

  return messages.filter((message) => {
    if (query && !messageMatchesQuery(message, query)) {
      return false;
    }

    if (senderName && message.senderName !== senderName) {
      return false;
    }

    if (date && getMessageDate(message) !== date) {
      return false;
    }

    return true;
  });
}

/**
 * 生成成员筛选器的候选项，按最近活跃时间倒序排列。
 */
export function getMessageParticipants(messages: ChatMessage[]): string[] {
  /**
   * 发送人到最近活跃时间的索引。
   */
  const latestActivityBySender = new Map<string, number>();

  for (const message of messages) {
    const senderName = message.senderName?.trim();

    if (!senderName) {
      continue;
    }

    latestActivityBySender.set(
      senderName,
      Math.max(
        latestActivityBySender.get(senderName) ?? Number.NEGATIVE_INFINITY,
        getMessageSortTime(message),
      ),
    );
  }

  return [...latestActivityBySender.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([senderName]) => senderName);
}

/**
 * 判断消息正文或发送人是否命中全文搜索。
 */
function messageMatchesQuery(message: ChatMessage, query: string): boolean {
  /**
   * 搜索范围包含发送人名称和消息正文。
   */
  const haystack = `${message.senderName ?? ""}\n${message.text}`.toLowerCase();

  return haystack.includes(query);
}

/**
 * 取消息的 yyyy-MM-dd 日期。
 */
function getMessageDate(message: ChatMessage): string {
  if (message.sentAt) {
    return message.sentAt.slice(0, 10);
  }

  return new Date(message.timestampMs).toISOString().slice(0, 10);
}

/**
 * 取消息排序和成员活跃度使用的时间值。
 */
function getMessageSortTime(message: ChatMessage): number {
  if (message.sentAt) {
    return Date.parse(message.sentAt);
  }

  return message.timestampMs;
}
