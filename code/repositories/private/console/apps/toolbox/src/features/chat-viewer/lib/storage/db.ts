import { openDB, type DBSchema } from "idb";

import {
  AnalysisReportSchema,
  ChatMessageSchema,
  FrameSampleSchema,
  OcrSegmentSchema,
  VideoProjectSchema,
  type AnalysisReport,
  type ChatMessage,
  type FrameSample,
  type OcrSegment,
  type VideoProject,
} from "@/features/chat-viewer/lib/domain/schemas";

/**
 * IndexedDB 默认数据库名。
 */
const defaultDbName = "chat-analysis-db";

/**
 * IndexedDB schema 版本号。
 */
const dbVersion = 1;

/**
 * 将 OCR 片段展开到独立对象仓库时使用的持久化结构。
 */
type StoredOcrSegment = OcrSegment & {
  id: string;
  projectId: string;
  frameId: string;
  segmentIndex: number;
};

/**
 * 本地聊天分析数据库的 IndexedDB schema。
 */
interface ChatAnalysisDbSchema extends DBSchema {
  projects: {
    key: string;
    value: VideoProject;
    indexes: {
      updatedAt: string;
    };
  };
  frames: {
    key: string;
    value: FrameSample;
    indexes: {
      projectId: string;
    };
  };
  ocrSegments: {
    key: string;
    value: StoredOcrSegment;
    indexes: {
      projectId: string;
    };
  };
  messages: {
    key: string;
    value: ChatMessage;
    indexes: {
      projectId: string;
    };
  };
  reports: {
    key: string;
    value: AnalysisReport;
    indexes: {
      projectId: string;
    };
  };
}

/**
 * 创建聊天分析数据库时的可选参数。
 */
export type CreateChatAnalysisDbOptions = {
  name?: string;
};

/**
 * 应用使用的数据库访问接口。
 */
export type ChatAnalysisDb = {
  /**
   * 保存或更新录屏分析项目。
   */
  saveProject(project: VideoProject): Promise<void>;

  /**
   * 按最近更新时间倒序列出项目。
   */
  listProjects(): Promise<VideoProject[]>;

  /**
   * 替换指定项目下的抽帧结果和 OCR 片段。
   */
  saveFrames(projectId: string, frames: FrameSample[]): Promise<void>;

  /**
   * 替换指定项目下的合并消息。
   */
  saveMessages(projectId: string, messages: ChatMessage[]): Promise<void>;

  /**
   * 读取指定项目下的聊天消息，按相对时间升序返回。
   */
  getProjectMessages(projectId: string): Promise<ChatMessage[]>;

  /**
   * 保存指定项目的分析报告。
   */
  saveReport(projectId: string, report: AnalysisReport): Promise<void>;

  /**
   * 读取指定项目的分析报告，不存在时返回 null。
   */
  getProjectReport(projectId: string): Promise<AnalysisReport | null>;

  /**
   * 清空所有本地项目和分析数据，用于隐私重置。
   */
  clearAllData(): Promise<void>;

  /**
   * 关闭底层 IndexedDB 连接。
   */
  close(): void;
};

/**
 * 创建并初始化聊天分析 IndexedDB 访问对象。
 */
export async function createChatAnalysisDb(
  options: CreateChatAnalysisDbOptions = {},
): Promise<ChatAnalysisDb> {
  /**
   * 已完成版本迁移的底层 IndexedDB 连接。
   */
  const db = await openDB<ChatAnalysisDbSchema>(
    options.name ?? defaultDbName,
    dbVersion,
    {
      upgrade(database) {
        if (!database.objectStoreNames.contains("projects")) {
          const projects = database.createObjectStore("projects", { keyPath: "id" });
          projects.createIndex("updatedAt", "updatedAt");
        }

        if (!database.objectStoreNames.contains("frames")) {
          const frames = database.createObjectStore("frames", { keyPath: "id" });
          frames.createIndex("projectId", "projectId");
        }

        if (!database.objectStoreNames.contains("ocrSegments")) {
          const ocrSegments = database.createObjectStore("ocrSegments", {
            keyPath: "id",
          });
          ocrSegments.createIndex("projectId", "projectId");
        }

        if (!database.objectStoreNames.contains("messages")) {
          const messages = database.createObjectStore("messages", { keyPath: "id" });
          messages.createIndex("projectId", "projectId");
        }

        if (!database.objectStoreNames.contains("reports")) {
          const reports = database.createObjectStore("reports", {
            keyPath: "projectId",
          });
          reports.createIndex("projectId", "projectId");
        }
      },
    },
  );

  return {
    /**
     * 持久化项目元数据。
     */
    async saveProject(project) {
      await db.put("projects", VideoProjectSchema.parse(project));
    },
    /**
     * 读取项目列表并按更新时间倒序展示。
     */
    async listProjects() {
      const projects = await db.getAll("projects");
      return projects.sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
    },
    /**
     * 原子替换项目的抽帧和 OCR 片段数据。
     */
    async saveFrames(projectId, frames) {
      const parsedFrames = frames.map((frame) => FrameSampleSchema.parse(frame));
      assertAllProjectIds(projectId, parsedFrames);

      const transaction = db.transaction(["frames", "ocrSegments"], "readwrite");
      await replaceByProjectId(transaction.objectStore("frames"), projectId);
      await replaceByProjectId(transaction.objectStore("ocrSegments"), projectId);

      for (const frame of parsedFrames) {
        await transaction.objectStore("frames").put(frame);
        for (const [segmentIndex, segment] of frame.ocrSegments.entries()) {
          const parsedSegment = OcrSegmentSchema.parse(segment);
          await transaction.objectStore("ocrSegments").put({
            ...parsedSegment,
            id: `${frame.id}:${segmentIndex}`,
            projectId,
            frameId: frame.id,
            segmentIndex,
          });
        }
      }

      await transaction.done;
    },
    /**
     * 原子替换项目的聊天消息数据。
     */
    async saveMessages(projectId, messages) {
      const parsedMessages = messages.map((message) =>
        ChatMessageSchema.parse(message),
      );
      assertAllProjectIds(projectId, parsedMessages);

      const transaction = db.transaction("messages", "readwrite");
      await replaceByProjectId(transaction.objectStore("messages"), projectId);

      for (const message of parsedMessages) {
        await transaction.objectStore("messages").put(message);
      }

      await transaction.done;
    },
    /**
     * 按项目读取聊天消息并保持时间线顺序。
     */
    async getProjectMessages(projectId) {
      const messages = await db.getAllFromIndex(
        "messages",
        "projectId",
        projectId,
      );

      return messages.sort((left, right) => {
        if (left.timestampMs !== right.timestampMs) {
          return left.timestampMs - right.timestampMs;
        }

        return left.id.localeCompare(right.id);
      });
    },
    /**
     * 校验并保存项目分析报告。
     */
    async saveReport(projectId, report) {
      const parsedReport = AnalysisReportSchema.parse(report);
      if (parsedReport.projectId !== projectId) {
        throw new Error("Report projectId does not match the target project");
      }

      await db.put("reports", parsedReport);
    },
    /**
     * 按项目读取已保存的分析报告。
     */
    async getProjectReport(projectId) {
      return (await db.get("reports", projectId)) ?? null;
    },
    /**
     * 清空所有对象仓库，移除本地保存的聊天内容和分析结果。
     */
    async clearAllData() {
      const transaction = db.transaction(
        ["projects", "frames", "ocrSegments", "messages", "reports"],
        "readwrite",
      );

      await Promise.all([
        transaction.objectStore("projects").clear(),
        transaction.objectStore("frames").clear(),
        transaction.objectStore("ocrSegments").clear(),
        transaction.objectStore("messages").clear(),
        transaction.objectStore("reports").clear(),
      ]);
      await transaction.done;
    },
    /**
     * 关闭当前数据库实例。
     */
    close() {
      db.close();
    },
  };
}

/**
 * 删除对象仓库中指定项目的旧数据，用于实现按项目全量替换。
 */
async function replaceByProjectId(
  store: {
    index(indexName: "projectId"): {
      getAllKeys(query: string): Promise<string[]>;
    };
    delete(key: string | IDBKeyRange): Promise<unknown>;
  },
  projectId: string,
): Promise<void> {
  const keys = await store.index("projectId").getAllKeys(projectId);
  await Promise.all(keys.map((key) => store.delete(key)));
}

/**
 * 确认批量写入的数据都属于同一个目标项目。
 */
function assertAllProjectIds(
  projectId: string,
  values: Array<{ projectId: string }>,
): void {
  if (values.some((value) => value.projectId !== projectId)) {
    throw new Error("Item projectId does not match the target project");
  }
}
