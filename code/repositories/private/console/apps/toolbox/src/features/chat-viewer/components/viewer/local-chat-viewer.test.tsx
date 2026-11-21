import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { deleteDB } from "idb";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocalChatViewer } from "./local-chat-viewer";

vi.mock("@/features/chat-viewer/components/viewer/chat-report-chart", () => ({
  ChatReportChart: ({ messages }: { messages: unknown[] }) => (
    <div data-testid="mock-echarts">ECharts 统计 {messages.length}</div>
  ),
}));

const dbName = "local-chat-viewer-test";

describe("LocalChatViewer", () => {
  beforeEach(async () => {
    await deleteDB(dbName);
  });

  afterEach(async () => {
    cleanup();
    await deleteDB(dbName);
  });

  it("imports pasted WeChat text and filters the local timeline", async () => {
    render(<LocalChatViewer dbName={dbName} />);

    expect(screen.getByText("默认本地处理，不上传聊天内容")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("聊天记录文本"), {
      target: {
        value: [
          "2026-06-10 09:15 林然",
          "今晚聚餐有人一起吗？",
          "",
          "2026-06-10 09:16 周宁",
          "@林然 可以，地点定了吗？",
        ].join("\n"),
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "导入聊天记录" }));

    expect(await screen.findByText("今晚聚餐有人一起吗？")).toBeInTheDocument();
    expect(screen.getByText("@林然 可以，地点定了吗？")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("搜索消息"), {
      target: { value: "地点" },
    });

    expect(screen.queryByText("今晚聚餐有人一起吗？")).not.toBeInTheDocument();
    expect(screen.getByText("@林然 可以，地点定了吗？")).toBeInTheDocument();
  });

  it("restores the most recent local project after remounting", async () => {
    const { unmount } = render(<LocalChatViewer dbName={dbName} />);

    fireEvent.change(screen.getByLabelText("聊天记录文本"), {
      target: { value: "林然: 今晚聚餐有人一起吗？" },
    });
    fireEvent.click(screen.getByRole("button", { name: "导入聊天记录" }));

    expect(await screen.findByText("今晚聚餐有人一起吗？")).toBeInTheDocument();

    unmount();
    render(<LocalChatViewer dbName={dbName} />);

    await waitFor(() => {
      expect(screen.getByText("今晚聚餐有人一起吗？")).toBeInTheDocument();
    });
  });

  it("exposes the video OCR workflow, exports, and local privacy reset controls", async () => {
    render(<LocalChatViewer dbName={dbName} />);

    expect(screen.getByText("录屏 OCR 分析")).toBeInTheDocument();
    expect(screen.getByLabelText("录屏文件")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "加载示例录屏 OCR" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "加载示例录屏 OCR" }));

    expect(await screen.findByText("今晚聚餐有人一起吗？")).toBeInTheDocument();
    expect(screen.getByText("OCR 进度 100%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导出 JSON" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "导出 CSV" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "导出 Markdown" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "清除本地数据" }));

    expect(await screen.findByText("暂无可显示的聊天消息")).toBeInTheDocument();
  });

  it("uses the configured chat region before sending video frames to OCR", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/components/viewer/local-chat-viewer.tsx"),
      "utf8",
    );

    expect(source).toContain("cropFrameToRegion(blob, region)");
    expect(source).toContain("frameBlobToOcrDataUrl(frame.blob, chatRegion)");
  });

  it("uses a bounded message window for large local projects", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/components/viewer/local-chat-viewer.tsx"),
      "utf8",
    );

    expect(source).toContain("getMessageWindow(filteredMessages");
    expect(source).toContain("visibleMessages.map");
  });
});
