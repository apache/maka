import type { ChatMessage } from "@/features/chat-viewer/lib/domain/schemas";

/**
 * 消息窗口化计算所需的参数。
 */
export type MessageWindowOptions = {
  limit: number;
};

/**
 * 消息窗口化计算后的渲染结果。
 */
export type MessageWindow = {
  visibleMessages: ChatMessage[];
  hiddenCount: number;
  hasMore: boolean;
};

/**
 * 从完整消息列表中截取当前需要渲染的有限窗口，避免大群聊一次性挂载过多 DOM 行。
 */
export function getMessageWindow(
  messages: ChatMessage[],
  options: MessageWindowOptions,
): MessageWindow {
  /**
   * 归一化后的窗口大小，负数和非有限值按 0 处理。
   */
  const limit = Number.isFinite(options.limit)
    ? Math.max(0, Math.floor(options.limit))
    : 0;

  /**
   * 当前真正渲染到表格中的消息集合。
   */
  const visibleMessages = messages.slice(0, limit);

  /**
   * 因窗口上限暂未渲染的消息数量。
   */
  const hiddenCount = Math.max(0, messages.length - visibleMessages.length);

  return {
    visibleMessages,
    hiddenCount,
    hasMore: hiddenCount > 0,
  };
}
