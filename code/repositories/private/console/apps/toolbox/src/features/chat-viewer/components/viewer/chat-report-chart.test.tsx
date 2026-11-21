import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "@/features/chat-viewer/lib/domain/schemas";

import { ChatReportChart } from "./chat-report-chart";

vi.mock("echarts-for-react", () => ({
  default: ({ option }: { option: unknown }) => (
    <pre data-testid="echarts-option">{JSON.stringify(option)}</pre>
  ),
}));

const messages: ChatMessage[] = [
  {
    id: "message-1",
    projectId: "project-1",
    senderName: "林然",
    text: "今晚聚餐有人一起吗？",
    timestampMs: 0,
  },
  {
    id: "message-2",
    projectId: "project-1",
    senderName: "周宁",
    text: "@林然 可以，地点定了吗？",
    timestampMs: 60_000,
  },
];

describe("ChatReportChart", () => {
  it("renders ECharts options for timeline and speaker ranking", () => {
    render(<ChatReportChart messages={messages} />);

    expect(screen.getByText("ECharts 统计")).toBeInTheDocument();
    expect(screen.getByTestId("echarts-option").textContent).toContain("发言趋势");
    expect(screen.getByTestId("echarts-option").textContent).toContain("成员排行");
    expect(screen.getByTestId("echarts-option").textContent).toContain("林然");
    expect(screen.getByTestId("echarts-option").textContent).toContain("周宁");
  });
});
