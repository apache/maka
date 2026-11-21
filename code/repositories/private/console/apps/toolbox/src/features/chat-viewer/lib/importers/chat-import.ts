import {
  ChatMessageSchema,
  VideoProjectSchema,
  type ChatMessage,
  type VideoProject,
} from "@/features/chat-viewer/lib/domain/schemas";

/**
 * 支持的本地聊天记录导入内容类型。
 */
export type ChatImportContentType =
  | "text/plain"
  | "text/csv"
  | "application/json";

/**
 * 本地聊天记录导入解析所需的输入数据。
 */
export type ChatImportInput = {
  projectId: string;
  sourceName: string;
  contentType: ChatImportContentType;
  content: string;
};

/**
 * 本地聊天记录导入解析后的项目和消息集合。
 */
export type ChatImportResult = {
  project: VideoProject;
  messages: ChatMessage[];
};

/**
 * 微信文本块头部，格式为 yyyy-MM-dd HH:mm 发送人。
 */
const WECHAT_TEXT_HEADER_PATTERN =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?\s+(.+)$/;

/**
 * 简单粘贴文本行，格式为 发送人: 内容。
 */
const SIMPLE_SENDER_LINE_PATTERN = /^([^:：\n]{1,64})[:：]\s*(.*)$/;

/**
 * Windows 和 Unix 换行统一切分时使用的正则。
 */
const LINE_BREAK_PATTERN = /\r?\n/;

/**
 * 将本地导入的文本、CSV 或 JSON 聊天记录解析成项目和标准消息。
 */
export function parseChatImport(input: ChatImportInput): ChatImportResult {
  /**
   * 当前导入动作使用的稳定项目元数据。
   */
  const project = buildImportedProject(input);

  /**
   * 根据内容类型选择解析器，避免 UI 层分支扩散。
   */
  const messages =
    input.contentType === "application/json"
      ? parseJsonMessages(input)
      : input.contentType === "text/csv"
        ? parseCsvMessages(input)
        : parseTextMessages(input);

  return {
    project,
    messages: withRelativeTimestamps(messages),
  };
}

/**
 * 根据导入来源构造本地项目元数据。
 */
function buildImportedProject(input: ChatImportInput): VideoProject {
  /**
   * 当前导入时间同时作为项目创建和更新时间。
   */
  const now = new Date().toISOString();

  return VideoProjectSchema.parse({
    id: input.projectId,
    title: stripFileExtension(input.sourceName.trim()) || "微信聊天记录",
    videoFileName: input.sourceName.trim() || "pasted-chat.txt",
    videoDurationMs: 0,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * 解析微信导出的多行文本或手动粘贴的发送人冒号文本。
 */
function parseTextMessages(input: ChatImportInput): ChatMessage[] {
  /**
   * 去掉尾部空白后的原始行数组。
   */
  const lines = input.content.split(LINE_BREAK_PATTERN).map((line) => line.trimEnd());

  /**
   * 优先尝试解析带时间头的微信文本块。
   */
  const blockMessages = parseWechatTextBlocks(input.projectId, lines);

  if (blockMessages.length > 0) {
    return blockMessages;
  }

  return lines
    .map((line, index) => parseSimpleSenderLine(input.projectId, line, index))
    .filter((message): message is ChatMessage => message !== null);
}

/**
 * 解析带时间头的微信聊天文本块。
 */
function parseWechatTextBlocks(projectId: string, lines: string[]): ChatMessage[] {
  /**
   * 从文本块中累积得到的消息集合。
   */
  const messages: ChatMessage[] = [];

  /**
   * 当前正在读取的消息头和正文。
   */
  let current:
    | {
        senderName: string;
        sentAt: string;
        textLines: string[];
      }
    | null = null;

  for (const line of lines) {
    const headerMatch = line.match(WECHAT_TEXT_HEADER_PATTERN);

    if (headerMatch) {
      if (current) {
        messages.push(buildMessage(projectId, messages.length, current));
      }

      current = {
        senderName: headerMatch[3].trim(),
        sentAt: normalizeDateTime(`${headerMatch[1]}T${headerMatch[2]}:00.000Z`),
        textLines: [],
      };
      continue;
    }

    if (!current || line.trim() === "") {
      continue;
    }

    current.textLines.push(line.trim());
  }

  if (current) {
    messages.push(buildMessage(projectId, messages.length, current));
  }

  return messages.filter((message) => message.text.trim() !== "");
}

/**
 * 解析单行发送人冒号格式。
 */
function parseSimpleSenderLine(
  projectId: string,
  line: string,
  index: number,
): ChatMessage | null {
  const match = line.match(SIMPLE_SENDER_LINE_PATTERN);

  if (!match) {
    return null;
  }

  return buildMessage(projectId, index, {
    senderName: match[1].trim(),
    textLines: [match[2].trim()],
  });
}

/**
 * 解析 CSV 文本，字段名支持 senderName、text、sentAt。
 */
function parseCsvMessages(input: ChatImportInput): ChatMessage[] {
  /**
   * CSV 行解析后的二维表格。
   */
  const rows = parseCsvRows(input.content);

  if (rows.length < 2) {
    return [];
  }

  /**
   * CSV 第一行作为字段名索引。
   */
  const headers = rows[0].map((header) => header.trim());

  return rows.slice(1).flatMap((row, index) => {
    const record = Object.fromEntries(
      headers.map((header, columnIndex) => [header, row[columnIndex] ?? ""]),
    );

    const text = record.text?.trim() ?? "";

    if (text === "") {
      return [];
    }

    return [
      buildMessage(input.projectId, index, {
        senderName: record.senderName?.trim() || null,
        textLines: [text],
        sentAt: normalizeOptionalDateTime(record.sentAt),
      }),
    ];
  });
}

/**
 * 解析 JSON 数组聊天记录，允许传入部分消息字段。
 */
function parseJsonMessages(input: ChatImportInput): ChatMessage[] {
  /**
   * JSON 原始解析结果。
   */
  const parsed = JSON.parse(input.content) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error("JSON chat import must be an array");
  }

  return parsed.flatMap((item, index) => {
    if (!isJsonMessageLike(item)) {
      return [];
    }

    const text = item.text.trim();

    if (text === "") {
      return [];
    }

    return [
      buildMessage(input.projectId, index, {
        senderName: item.senderName?.trim() || null,
        textLines: [text],
        sentAt: normalizeOptionalDateTime(item.sentAt),
      }),
    ];
  });
}

/**
 * 判断 JSON 记录是否具备最小聊天消息字段。
 */
function isJsonMessageLike(
  item: unknown,
): item is { senderName?: string | null; text: string; sentAt?: string } {
  return (
    typeof item === "object" &&
    item !== null &&
    "text" in item &&
    typeof (item as { text: unknown }).text === "string"
  );
}

/**
 * 构造符合领域 schema 的聊天消息。
 */
function buildMessage(
  projectId: string,
  index: number,
  input: {
    senderName: string | null;
    textLines: string[];
    sentAt?: string;
  },
): ChatMessage {
  /**
   * 消息正文保留多行内容，用换行连接。
   */
  const text = input.textLines.join("\n").trim();

  return ChatMessageSchema.parse({
    id: `${projectId}:message-${index + 1}`,
    projectId,
    senderName: input.senderName,
    text,
    timestampMs: index * 60_000,
    sentAt: input.sentAt,
  });
}

/**
 * 将有绝对发送时间的消息转换为从首条消息开始的相对毫秒数。
 */
function withRelativeTimestamps(messages: ChatMessage[]): ChatMessage[] {
  /**
   * 第一条可解析发送时间的毫秒值。
   */
  const firstSentAtMs = messages
    .map((message) => (message.sentAt ? Date.parse(message.sentAt) : Number.NaN))
    .find((value) => Number.isFinite(value));

  if (firstSentAtMs === undefined) {
    return messages;
  }

  return messages.map((message, index) => {
    if (!message.sentAt) {
      return {
        ...message,
        timestampMs: index * 60_000,
      };
    }

    return {
      ...message,
      timestampMs: Math.max(0, Date.parse(message.sentAt) - firstSentAtMs),
    };
  });
}

/**
 * 解析 CSV 内容，支持双引号包裹字段和双引号转义。
 */
function parseCsvRows(content: string): string[][] {
  /**
   * CSV 解析后的行集合。
   */
  const rows: string[][] = [];

  /**
   * 当前正在读取的行。
   */
  let row: string[] = [];

  /**
   * 当前正在读取的单元格。
   */
  let cell = "";

  /**
   * 当前是否处于双引号字段内。
   */
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const nextChar = content[index + 1];

    if (char === "\"" && inQuotes && nextChar === "\"") {
      cell += "\"";
      index += 1;
      continue;
    }

    if (char === "\"") {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && nextChar === "\n") {
        index += 1;
      }

      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(cell);
  rows.push(row);

  return rows.filter((currentRow) =>
    currentRow.some((currentCell) => currentCell.trim() !== ""),
  );
}

/**
 * 将文件名扩展名去掉，用作默认项目标题。
 */
function stripFileExtension(sourceName: string): string {
  return sourceName.replace(/\.[^.]+$/, "");
}

/**
 * 可选日期时间字段的归一化入口。
 */
function normalizeOptionalDateTime(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  return normalizeDateTime(value);
}

/**
 * 将本地导入时间字符串归一化为 ISO datetime。
 */
function normalizeDateTime(value: string): string {
  const normalizedValue = value.includes("T")
    ? value
    : value.replace(" ", "T");

  const date = new Date(
    /(?:Z|[+-]\d{2}:\d{2})$/.test(normalizedValue)
      ? normalizedValue
      : `${normalizedValue}Z`,
  );

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid chat message sentAt: ${value}`);
  }

  return date.toISOString();
}
