"use client";

import dynamic from "next/dynamic";
import {
  Database,
  Download,
  FileUp,
  Film,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/features/chat-viewer/components/ui/badge";
import { Button } from "@/features/chat-viewer/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/features/chat-viewer/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/features/chat-viewer/components/ui/table";
import { buildAnalysisReport } from "@/features/chat-viewer/lib/analysis/analyze";
import { buildPersistentAnalysisReport } from "@/features/chat-viewer/lib/analysis/persistent-report";
import type { ChatMessage, Rect, VideoProject } from "@/features/chat-viewer/lib/domain/schemas";
import {
  exportMessagesToCsv,
  exportMessagesToJson,
  exportMessagesToMarkdown,
} from "@/features/chat-viewer/lib/export/chat-export";
import {
  parseChatImport,
  type ChatImportContentType,
} from "@/features/chat-viewer/lib/importers/chat-import";
import type { OcrEngine, OcrInput, OcrResult } from "@/features/chat-viewer/lib/ocr/types";
import { analyzeVideoFrameImages, type VideoFrameImage } from "@/features/chat-viewer/lib/pipeline/video-analysis";
import { createChatAnalysisDb, type ChatAnalysisDb } from "@/features/chat-viewer/lib/storage/db";
import { sampleVideoFrames } from "@/features/chat-viewer/lib/video/frame-sampler";
import { cropFrameToRegion } from "@/features/chat-viewer/lib/video/region-detect";
import {
  filterMessages,
  getMessageParticipants,
} from "@/features/chat-viewer/lib/viewer/message-filter";
import { getMessageWindow } from "@/features/chat-viewer/lib/viewer/message-window";

/**
 * ECharts 依赖较重，仅在客户端查看器中按需加载。
 */
const DynamicChatReportChart = dynamic(
  () =>
    import("@/features/chat-viewer/components/viewer/chat-report-chart").then(
      (module) => module.ChatReportChart,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="rounded-lg border border-zinc-200 bg-white p-5 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
        正在加载统计图表
      </div>
    ),
  },
);

/**
 * 本地聊天查看器组件的可选配置。
 */
export type LocalChatViewerProps = {
  dbName?: string;
};

/**
 * 导入格式选择器中的可选项。
 */
const importFormatOptions: Array<{
  label: string;
  value: ChatImportContentType;
}> = [
  { label: "微信文本", value: "text/plain" },
  { label: "CSV", value: "text/csv" },
  { label: "JSON", value: "application/json" },
];

/**
 * OCR 区域设置的默认值，覆盖桌面微信主聊天区域的大致范围。
 */
const defaultChatRegion: Rect = {
  x: 280,
  y: 48,
  width: 900,
  height: 500,
};

/**
 * 消息时间线默认渲染上限，避免大群聊一次性挂载过多表格行。
 */
const messageRenderLimit = 500;

/**
 * 本地优先的微信聊天记录查看器，负责导入、筛选、浏览和持久化。
 */
export function LocalChatViewer({ dbName }: LocalChatViewerProps) {
  /**
   * 当前 IndexedDB 实例引用，避免频繁放入 React 状态触发渲染。
   */
  const dbRef = useRef<ChatAnalysisDb | null>(null);

  /**
   * 正在初始化的数据库 Promise，用于合并并发打开请求。
   */
  const dbPromiseRef = useRef<Promise<ChatAnalysisDb> | null>(null);

  /**
   * 文本导入区域中的原始聊天记录。
   */
  const [rawText, setRawText] = useState("");

  /**
   * 文本导入区域当前选择的内容格式。
   */
  const [contentType, setContentType] =
    useState<ChatImportContentType>("text/plain");

  /**
   * 当前已加载的本地项目。
   */
  const [project, setProject] = useState<VideoProject | null>(null);

  /**
   * 当前项目下的标准化聊天消息。
   */
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  /**
   * 全文搜索关键词。
   */
  const [query, setQuery] = useState("");

  /**
   * 成员筛选值。
   */
  const [senderName, setSenderName] = useState("");

  /**
   * 日期筛选值。
   */
  const [date, setDate] = useState("");

  /**
   * 页面顶部展示的操作状态。
   */
  const [status, setStatus] = useState("正在准备本地数据库");

  /**
   * 最近一次导入或读取失败的错误信息。
   */
  const [error, setError] = useState<string | null>(null);

  /**
   * 用户选择的录屏文件。
   */
  const [videoFile, setVideoFile] = useState<File | null>(null);

  /**
   * OCR 处理进度百分比。
   */
  const [ocrProgress, setOcrProgress] = useState(0);

  /**
   * OCR 流程状态文案。
   */
  const [ocrStatus, setOcrStatus] = useState("等待录屏文件");

  /**
   * 用户可调整的聊天区域裁剪配置。
   */
  const [chatRegion, setChatRegion] = useState<Rect>(defaultChatRegion);

  /**
   * 获取或创建本地 IndexedDB 访问对象。
   */
  const getDb = useCallback(async () => {
    if (dbRef.current) {
      return dbRef.current;
    }

    if (!dbPromiseRef.current) {
      dbPromiseRef.current = createChatAnalysisDb({ name: dbName }).then(
        (database) => {
          dbRef.current = database;
          return database;
        },
      );
    }

    return dbPromiseRef.current;
  }, [dbName]);

  useEffect(() => {
    /**
     * 组件卸载后阻止异步读取继续写入状态。
     */
    let cancelled = false;

    /**
     * 从本地数据库恢复最近更新的项目。
     */
    async function restoreLatestProject() {
      try {
        const database = await getDb();
        const [latestProject] = await database.listProjects();

        if (cancelled) {
          return;
        }

        if (!latestProject) {
          setStatus("等待导入聊天记录");
          return;
        }

        const restoredMessages = await database.getProjectMessages(latestProject.id);

        if (cancelled) {
          return;
        }

        setProject(latestProject);
        setMessages(restoredMessages);
        setOcrProgress(restoredMessages.length > 0 ? 100 : 0);
        setStatus(`已恢复本地项目：${latestProject.title}`);
      } catch (restoreError) {
        if (!cancelled) {
          setError(getErrorMessage(restoreError));
          setStatus("本地数据恢复失败");
        }
      }
    }

    void restoreLatestProject();

    return () => {
      cancelled = true;
      dbRef.current?.close();
      dbRef.current = null;
      dbPromiseRef.current = null;
    };
  }, [getDb]);

  /**
   * 当前筛选条件下展示的消息列表。
   */
  const filteredMessages = useMemo(
    () => filterMessages(messages, { query, senderName, date }),
    [date, messages, query, senderName],
  );

  /**
   * 当前筛选结果的有限渲染窗口。
   */
  const messageWindow = useMemo(
    () => getMessageWindow(filteredMessages, { limit: messageRenderLimit }),
    [filteredMessages],
  );

  /**
   * 成员筛选器选项。
   */
  const participants = useMemo(() => getMessageParticipants(messages), [messages]);

  /**
   * 当前消息集合生成的基础统计报告。
   */
  const report = useMemo(() => buildAnalysisReport(messages), [messages]);

  /**
   * 处理文本区域导入。
   */
  async function handleImportText() {
    if (rawText.trim() === "") {
      setError("请先粘贴聊天记录文本");
      return;
    }

    await importContent({
      sourceName: contentType === "text/plain" ? "粘贴文本.txt" : `粘贴记录.${getExtension(contentType)}`,
      contentType,
      content: rawText,
    });
  }

  /**
   * 处理本地文件导入。
   */
  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    await importContent({
      sourceName: file.name,
      contentType: inferContentType(file),
      content: await file.text(),
    });

    event.target.value = "";
  }

  /**
   * 解析、保存并加载一次导入内容。
   */
  async function importContent({
    sourceName,
    contentType: nextContentType,
    content,
  }: {
    sourceName: string;
    contentType: ChatImportContentType;
    content: string;
  }) {
    try {
      setError(null);
      setStatus("正在导入聊天记录");

      const database = await getDb();
      const imported = parseChatImport({
        projectId: createProjectId(),
        sourceName,
        contentType: nextContentType,
        content,
      });

        const importedReport = buildPersistentAnalysisReport(
          imported.project.id,
          imported.messages,
        );

        await database.saveProject(imported.project);
        await database.saveMessages(imported.project.id, imported.messages);
        await database.saveReport(imported.project.id, importedReport);

      setProject(imported.project);
      setMessages(imported.messages);
      setQuery("");
      setSenderName("");
      setDate("");
        setStatus(`已导入 ${imported.messages.length} 条消息`);
      } catch (importError) {
        setError(getErrorMessage(importError));
        setStatus("导入失败");
      }
  }

  /**
   * 记录录屏文件选择，并尝试从文件名生成状态提示。
   */
  function handleVideoFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;

    setVideoFile(file);
    setError(null);
    setOcrProgress(0);
    setOcrStatus(file ? `已选择录屏：${file.name}` : "等待录屏文件");
  }

  /**
   * 更新单个裁剪区域字段。
   */
  function updateChatRegionField(field: keyof Rect, value: string) {
    const nextValue = Math.max(0, Number(value) || 0);

    setChatRegion((currentRegion) => ({
      ...currentRegion,
      [field]: nextValue,
    }));
  }

  /**
   * 使用真实录屏文件执行抽帧和 OCR 分析。
   */
  async function handleRunVideoOcr() {
    if (!videoFile) {
      setError("请先选择录屏文件");
      return;
    }

    try {
      setError(null);
      setOcrProgress(0);
      setOcrStatus("正在抽取录屏帧");

      const sampledFrames = await sampleVideoFrames(videoFile, {
        durationSeconds: 0,
        framesPerSecond: 0.2,
        maxFrames: 8,
        onProgress: (progress) => {
          setOcrStatus(`已抽取 ${progress.completedFrames}/${progress.totalFrames} 帧`);
        },
      });

      const frameImages = await Promise.all(
        sampledFrames.map(async (frame): Promise<VideoFrameImage> => ({
          imageDataUrl: await frameBlobToOcrDataUrl(frame.blob, chatRegion),
          timestampMs: Math.round(frame.timeSeconds * 1000),
          width: frame.width,
          height: frame.height,
        })),
      );

      const { TesseractOcrEngine } = await import("@/features/chat-viewer/lib/ocr/tesseract-engine");
      const projectId = createProjectId();
      const analysis = await analyzeVideoFrameImages({
        projectId,
        frames: frameImages,
        ocrEngine: new TesseractOcrEngine(),
        onProgress: (progress) => {
          const percent =
            progress.totalFrames === 0
              ? 0
              : Math.round((progress.completedFrames / progress.totalFrames) * 100);
          setOcrProgress(percent);
          setOcrStatus(
            progress.stage === "ocr"
              ? `OCR 识别 ${progress.completedFrames}/${progress.totalFrames} 帧`
              : "正在合并聊天消息",
          );
        },
      });

      await persistAnalysisResult({
        project: buildVideoProject({
          id: projectId,
          fileName: videoFile.name,
          durationMs: Math.max(0, ...frameImages.map((frame) => frame.timestampMs)),
        }),
        frames: analysis.frames,
        messages: analysis.messages,
        report: analysis.report,
      });

      setOcrProgress(100);
      setOcrStatus("OCR 分析完成");
    } catch (ocrError) {
      setError(getErrorMessage(ocrError));
      setOcrStatus("OCR 分析失败，可调整区域后重试");
    }
  }

  /**
   * 加载内置示例录屏 OCR 结果，用于无视频文件时快速体验 P1 主链路。
   */
  async function handleLoadSampleVideoOcr() {
    try {
      setError(null);
      setOcrProgress(0);
      setOcrStatus("正在加载示例 OCR");

      const projectId = createProjectId();
      const analysis = await analyzeVideoFrameImages({
        projectId,
        frames: [
          {
            imageDataUrl: "data:image/png;base64,sample-frame-1",
            timestampMs: 0,
            width: 1280,
            height: 720,
          },
          {
            imageDataUrl: "data:image/png;base64,sample-frame-2",
            timestampMs: 60_000,
            width: 1280,
            height: 720,
          },
        ],
        ocrEngine: new SampleOcrEngine(),
        onProgress: (progress) => {
          const percent = Math.round(
            (progress.completedFrames / Math.max(1, progress.totalFrames)) * 100,
          );
          setOcrProgress(percent);
        },
      });

      await persistAnalysisResult({
        project: buildVideoProject({
          id: projectId,
          fileName: "示例录屏.mp4",
          durationMs: 60_000,
        }),
        frames: analysis.frames,
        messages: analysis.messages,
        report: analysis.report,
      });

      setOcrProgress(100);
      setOcrStatus("示例 OCR 分析完成");
    } catch (sampleError) {
      setError(getErrorMessage(sampleError));
      setOcrStatus("示例 OCR 加载失败");
    }
  }

  /**
   * 持久化一次视频或示例分析结果，并刷新当前视图。
   */
  async function persistAnalysisResult({
    project: nextProject,
    frames,
    messages: nextMessages,
    report: nextReport,
  }: {
    project: VideoProject;
    frames: Awaited<ReturnType<typeof analyzeVideoFrameImages>>["frames"];
    messages: ChatMessage[];
    report: Awaited<ReturnType<typeof analyzeVideoFrameImages>>["report"];
  }) {
    const database = await getDb();

    await database.saveProject(nextProject);
    await database.saveFrames(nextProject.id, frames);
    await database.saveMessages(nextProject.id, nextMessages);
    await database.saveReport(nextProject.id, nextReport);

    setProject(nextProject);
    setMessages(nextMessages);
    setQuery("");
    setSenderName("");
    setDate("");
    setStatus(`已导入 ${nextMessages.length} 条 OCR 消息`);
  }

  /**
   * 清空浏览器本地保存的聊天内容和分析结果。
   */
  async function handleClearLocalData() {
    const database = await getDb();

    await database.clearAllData();
    setProject(null);
    setMessages([]);
    setRawText("");
    setQuery("");
    setSenderName("");
    setDate("");
    setOcrProgress(0);
    setOcrStatus("等待录屏文件");
    setStatus("已清除本地数据");
  }

  /**
   * 以指定格式下载当前消息。
   */
  function handleExport(format: "json" | "csv" | "markdown") {
    const exporters = {
      json: {
        fileName: "wechat-chat.json",
        mimeType: "application/json;charset=utf-8",
        content: exportMessagesToJson(messages),
      },
      csv: {
        fileName: "wechat-chat.csv",
        mimeType: "text/csv;charset=utf-8",
        content: exportMessagesToCsv(messages),
      },
      markdown: {
        fileName: "wechat-chat-report.md",
        mimeType: "text/markdown;charset=utf-8",
        content: exportMessagesToMarkdown(messages),
      },
    } as const;

    downloadTextFile(exporters[format]);
  }

  return (
    <main className="min-h-screen bg-zinc-100 px-4 py-5 text-zinc-950 dark:bg-zinc-950 dark:text-zinc-50 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-5">
        <header className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">Local MVP</Badge>
            <span className="inline-flex items-center gap-1 text-sm text-emerald-700 dark:text-emerald-400">
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              默认本地处理，不上传聊天内容
            </span>
          </div>
          <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-2">
              <h1 className="text-3xl font-semibold tracking-normal">
                微信聊天记录查看器
              </h1>
              <p className="max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
                导入文本、CSV 或 JSON 后，在浏览器本地完成浏览、搜索、筛选和统计。
              </p>
            </div>
            <div className="inline-flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
              <Database className="h-4 w-4" aria-hidden="true" />
              {status}
            </div>
          </div>
        </header>

        {error ? (
          <div
            className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-300"
            role="alert"
          >
            {error}
          </div>
        ) : null}

        <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
          <div className="space-y-5">
            <Card>
              <CardHeader>
                <CardTitle>导入聊天记录</CardTitle>
                <CardDescription>
                  支持微信文本块、发送人冒号文本、CSV 和 JSON 数组。
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <label className="grid gap-2 text-sm font-medium">
                  导入格式
                  <select
                    className="h-10 rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-950 outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50"
                    value={contentType}
                    onChange={(event) =>
                      setContentType(event.target.value as ChatImportContentType)
                    }
                  >
                    {importFormatOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="grid gap-2 text-sm font-medium">
                  聊天记录文本
                  <textarea
                    className="min-h-56 resize-y rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-950 outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50"
                    placeholder="2026-06-10 09:15 林然&#10;今晚聚餐有人一起吗？"
                    value={rawText}
                    onChange={(event) => setRawText(event.target.value)}
                  />
                </label>

                <div className="flex flex-col gap-3 sm:flex-row">
                  <Button className="w-full" onClick={handleImportText}>
                    <FileUp className="h-4 w-4" aria-hidden="true" />
                    导入聊天记录
                  </Button>
                  <label className="inline-flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-900">
                    <FileUp className="h-4 w-4" aria-hidden="true" />
                    选择文件
                    <input
                      className="sr-only"
                      aria-label="聊天记录文件"
                      type="file"
                      accept=".txt,.csv,.json,text/plain,text/csv,application/json"
                      onChange={handleFileChange}
                    />
                  </label>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>录屏 OCR 分析</CardTitle>
                <CardDescription>
                  从微信录屏抽帧识别文字，支持调整聊天区域后重试。
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <label className="inline-flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-900">
                  <Film className="h-4 w-4" aria-hidden="true" />
                  {videoFile ? videoFile.name : "选择录屏文件"}
                  <input
                    className="sr-only"
                    aria-label="录屏文件"
                    type="file"
                    accept="video/*"
                    onChange={handleVideoFileChange}
                  />
                </label>

                <div className="grid grid-cols-2 gap-3">
                  {(["x", "y", "width", "height"] as Array<keyof Rect>).map((field) => (
                    <label key={field} className="grid min-w-0 gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                      {field}
                      <input
                        className="h-9 w-full min-w-0 rounded-md border border-zinc-200 bg-white px-2 text-sm text-zinc-950 outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50"
                        type="number"
                        min="0"
                        value={chatRegion[field]}
                        onChange={(event) => updateChatRegionField(field, event.target.value)}
                      />
                    </label>
                  ))}
                </div>

                <div className="rounded-md bg-zinc-50 p-3 text-sm text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
                  OCR 进度 {ocrProgress}%
                  <div className="mt-1 text-xs">{ocrStatus}</div>
                </div>

                <div className="grid gap-3">
                  <Button className="w-full" onClick={handleRunVideoOcr}>
                    <Film className="h-4 w-4" aria-hidden="true" />
                    开始 OCR 分析
                  </Button>
                  <Button className="w-full" variant="outline" onClick={handleLoadSampleVideoOcr}>
                    加载示例录屏 OCR
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>导出与隐私</CardTitle>
                <CardDescription>
                  导出结果文件或清除浏览器本地数据。
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3">
                <Button
                  variant="outline"
                  disabled={messages.length === 0}
                  onClick={() => handleExport("json")}
                >
                  <Download className="h-4 w-4" aria-hidden="true" />
                  导出 JSON
                </Button>
                <Button
                  variant="outline"
                  disabled={messages.length === 0}
                  onClick={() => handleExport("csv")}
                >
                  <Download className="h-4 w-4" aria-hidden="true" />
                  导出 CSV
                </Button>
                <Button
                  variant="outline"
                  disabled={messages.length === 0}
                  onClick={() => handleExport("markdown")}
                >
                  <Download className="h-4 w-4" aria-hidden="true" />
                  导出 Markdown
                </Button>
                <Button variant="ghost" onClick={handleClearLocalData}>
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  清除本地数据
                </Button>
              </CardContent>
            </Card>
          </div>

          <section className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-3">
              <Metric label="总消息" value={messages.length.toString()} />
              <Metric label="成员数" value={participants.length.toString()} />
              <Metric
                label="有效消息"
                value={report.validMessages.toString()}
              />
            </div>

            {messages.length > 0 ? (
              <DynamicChatReportChart messages={messages} />
            ) : null}

            <Card>
              <CardHeader>
                <CardTitle>搜索与筛选</CardTitle>
                <CardDescription>
                  当前显示 {filteredMessages.length} 条消息
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 md:grid-cols-[1fr_180px_180px]">
                <label className="grid gap-2 text-sm font-medium">
                  搜索消息
                  <span className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" aria-hidden="true" />
                    <input
                      className="h-10 w-full rounded-md border border-zinc-200 bg-white pl-9 pr-3 text-sm text-zinc-950 outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </span>
                </label>

                <label className="grid gap-2 text-sm font-medium">
                  成员筛选
                  <select
                    className="h-10 rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-950 outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50"
                    value={senderName}
                    onChange={(event) => setSenderName(event.target.value)}
                  >
                    <option value="">全部成员</option>
                    {participants.map((participant) => (
                      <option key={participant} value={participant}>
                        {participant}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="grid gap-2 text-sm font-medium">
                  日期筛选
                  <input
                    className="h-10 rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-950 outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50"
                    type="date"
                    value={date}
                    onChange={(event) => setDate(event.target.value)}
                  />
                </label>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <CardTitle>消息时间线</CardTitle>
                    <CardDescription>
                      {project ? project.title : "导入后显示本地聊天记录"}
                    </CardDescription>
                  </div>
                  <Badge variant="outline">{filteredMessages.length} 条</Badge>
                </div>
              </CardHeader>
              <CardContent>
                {filteredMessages.length > 0 ? (
                  <div className="space-y-3">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-36">时间</TableHead>
                          <TableHead className="w-32">成员</TableHead>
                          <TableHead>内容</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {messageWindow.visibleMessages.map((message) => (
                          <TableRow key={message.id}>
                            <TableCell className="whitespace-nowrap text-zinc-500">
                              {formatMessageTime(message)}
                            </TableCell>
                            <TableCell className="font-medium">
                              {message.senderName ?? "未知"}
                            </TableCell>
                            <TableCell className="whitespace-pre-wrap leading-6">
                              {message.text}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    {messageWindow.hasMore ? (
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">
                        还有 {messageWindow.hiddenCount} 条消息未渲染，可继续筛选缩小范围。
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                    暂无可显示的聊天消息
                  </div>
                )}
              </CardContent>
            </Card>
          </section>
        </div>
      </div>
    </main>
  );
}

/**
 * 顶部统计使用的紧凑指标块。
 */
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold">{value}</div>
      </CardContent>
    </Card>
  );
}

/**
 * 为一次导入生成本地项目 ID。
 */
function createProjectId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `project-${Date.now()}`;
}

/**
 * 构建视频导入生成的项目元数据。
 */
function buildVideoProject({
  id,
  fileName,
  durationMs,
}: {
  id: string;
  fileName: string;
  durationMs: number;
}): VideoProject {
  /**
   * 项目创建和更新时间。
   */
  const now = new Date().toISOString();

  return {
    id,
    title: stripFileExtension(fileName) || "微信录屏分析",
    videoFileName: fileName,
    videoDurationMs: durationMs,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 根据文件信息推断导入内容类型。
 */
function inferContentType(file: File): ChatImportContentType {
  if (file.type === "application/json" || file.name.endsWith(".json")) {
    return "application/json";
  }

  if (file.type === "text/csv" || file.name.endsWith(".csv")) {
    return "text/csv";
  }

  return "text/plain";
}

/**
 * 根据内容类型取默认扩展名。
 */
function getExtension(contentType: ChatImportContentType): string {
  if (contentType === "application/json") {
    return "json";
  }

  if (contentType === "text/csv") {
    return "csv";
  }

  return "txt";
}

/**
 * 将 Blob 图片帧转为 OCR 可读取的 data URL。
 */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Unable to read sampled frame."));
    reader.readAsDataURL(blob);
  });
}

/**
 * 根据聊天区域设置准备 OCR 输入图像。
 */
async function frameBlobToOcrDataUrl(blob: Blob, region: Rect): Promise<string> {
  if (region.width === 0 || region.height === 0) {
    return blobToDataUrl(blob);
  }

  const image = await cropFrameToRegion(blob, region);

  try {
    return imageBitmapToDataUrl(image);
  } finally {
    image.close();
  }
}

/**
 * 将裁剪后的 ImageBitmap 编码为 data URL。
 */
function imageBitmapToDataUrl(image: ImageBitmap): string {
  const canvas = document.createElement("canvas");

  canvas.width = image.width;
  canvas.height = image.height;

  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Unable to create OCR canvas context.");
  }

  context.drawImage(image, 0, 0);

  return canvas.toDataURL("image/png");
}

/**
 * 触发浏览器下载文本文件。
 */
function downloadTextFile({
  fileName,
  mimeType,
  content,
}: {
  fileName: string;
  mimeType: string;
  content: string;
}) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * 去掉文件扩展名，用于项目标题。
 */
function stripFileExtension(sourceName: string): string {
  return sourceName.replace(/\.[^.]+$/, "");
}

/**
 * 将消息时间格式化为适合表格展示的文本。
 */
function formatMessageTime(message: ChatMessage): string {
  if (message.sentAt) {
    return message.sentAt.replace("T", " ").slice(0, 16);
  }

  return `${Math.round(message.timestampMs / 60_000)} 分钟`;
}

/**
 * 将未知错误转换为用户可读文案。
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "未知错误";
}

/**
 * 内置示例 OCR 引擎，用于无视频文件时体验录屏分析主链路。
 */
class SampleOcrEngine implements OcrEngine {
  /**
   * 示例帧对应的 OCR 结果。
   */
  private readonly results: OcrResult[] = [
    {
      engineName: "sample",
      segments: [{ text: "林然: 今晚聚餐有人一起吗？", confidence: 0.93 }],
    },
    {
      engineName: "sample",
      segments: [{ text: "周宁: @林然 可以，地点定了吗？", confidence: 0.91 }],
    },
  ];

  /**
   * 按调用顺序返回示例 OCR 结果。
   */
  async recognize(input: OcrInput): Promise<OcrResult> {
    void input;

    return (
      this.results.shift() ?? {
        engineName: "sample",
        segments: [],
      }
    );
  }
}
