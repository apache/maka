import { buildPersistentAnalysisReport } from "@/features/chat-viewer/lib/analysis/persistent-report";
import type { ChatMessage } from "@/features/chat-viewer/lib/domain/schemas";

/**
 * 将聊天消息导出为 CSV 文本。
 */
export function exportMessagesToCsv(messages: ChatMessage[]): string {
  /**
   * CSV 表头字段。
   */
  const header = ["sentAt", "senderName", "text"];

  /**
   * CSV 数据行。
   */
  const rows = messages.map((message) => [
    message.sentAt ?? "",
    message.senderName ?? "",
    message.text,
  ]);

  return [header, ...rows]
    .map((row) => row.map(escapeCsvCell).join(","))
    .join("\n");
}

/**
 * 将聊天消息导出为格式化 JSON 文本。
 */
export function exportMessagesToJson(messages: ChatMessage[]): string {
  return JSON.stringify(messages, null, 2);
}

/**
 * 将聊天消息导出为 Markdown 分析报告。
 */
export function exportMessagesToMarkdown(messages: ChatMessage[]): string {
  /**
   * 基于当前消息生成的导出摘要。
   */
  const report = buildPersistentAnalysisReport(
    messages[0]?.projectId ?? "local-project",
    messages,
  );

  /**
   * Markdown 表格行。
   */
  const rows = messages.map(
    (message) =>
      `| ${escapeMarkdownCell(message.sentAt ?? "")} | ${escapeMarkdownCell(message.senderName ?? "未知")} | ${escapeMarkdownCell(message.text)} |`,
  );

  return [
    "# 微信聊天记录分析报告",
    "",
    "> 默认本地处理，不上传聊天内容。",
    "",
    `- 总消息：${report.messageCount}`,
    `- 参与成员：${report.participantCount}`,
    `- 关键词：${
      report.topKeywords.map((item) => `${item.keyword} ${item.count}`).join("、") ||
      "暂无"
    }`,
    "",
    "| 时间 | 成员 | 内容 |",
    "| --- | --- | --- |",
    ...rows,
  ].join("\n");
}

/**
 * 转义 CSV 单元格。
 */
function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value) || value.startsWith("@")) {
    return `"${value.replaceAll("\"", "\"\"")}"`;
  }

  return value;
}

/**
 * 转义 Markdown 表格单元格。
 */
function escapeMarkdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", "<br>");
}
