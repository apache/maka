"use client";

import ReactECharts from "echarts-for-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/features/chat-viewer/components/ui/card";
import type { ChatMessage } from "@/features/chat-viewer/lib/domain/schemas";

/**
 * 聊天统计图表组件需要的消息数据。
 */
export type ChatReportChartProps = {
  messages: ChatMessage[];
};

/**
 * 使用 ECharts 展示发言趋势和成员排行。
 */
export function ChatReportChart({ messages }: ChatReportChartProps) {
  /**
   * 图表渲染所需的 ECharts option。
   */
  const option = buildChartOption(messages);

  return (
    <Card>
      <CardHeader>
        <CardTitle>ECharts 统计</CardTitle>
        <CardDescription>发言趋势与成员排行</CardDescription>
      </CardHeader>
      <CardContent>
        <ReactECharts option={option} style={{ height: 280, width: "100%" }} />
      </CardContent>
    </Card>
  );
}

/**
 * 根据消息集合构造 ECharts 配置。
 */
function buildChartOption(messages: ChatMessage[]) {
  /**
   * 趋势数据，按相对分钟聚合。
   */
  const timeline = buildTimeline(messages);

  /**
   * 成员排行数据。
   */
  const speakerRanking = buildSpeakerRanking(messages);

  return {
    color: ["#059669", "#2563eb"],
    tooltip: { trigger: "axis" },
    legend: { top: 0, data: ["发言趋势", "成员排行"] },
    grid: [
      { left: 40, right: 24, top: 48, height: 90 },
      { left: 40, right: 24, top: 180, height: 70 },
    ],
    xAxis: [
      {
        type: "category",
        gridIndex: 0,
        data: timeline.map((item) => item.label),
      },
      {
        type: "category",
        gridIndex: 1,
        data: speakerRanking.map((item) => item.senderName),
      },
    ],
    yAxis: [
      { type: "value", gridIndex: 0, minInterval: 1 },
      { type: "value", gridIndex: 1, minInterval: 1 },
    ],
    series: [
      {
        name: "发言趋势",
        type: "line",
        smooth: true,
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: timeline.map((item) => item.count),
      },
      {
        name: "成员排行",
        type: "bar",
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: speakerRanking.map((item) => item.count),
      },
    ],
  };
}

/**
 * 按相对分钟聚合消息趋势。
 */
function buildTimeline(messages: ChatMessage[]): Array<{ label: string; count: number }> {
  /**
   * 分钟标签到消息数量的聚合表。
   */
  const counts = new Map<string, number>();

  for (const message of messages) {
    const label = `${Math.round(message.timestampMs / 60_000)} 分钟`;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  return [...counts.entries()].map(([label, count]) => ({ label, count }));
}

/**
 * 按成员聚合发言数量。
 */
function buildSpeakerRanking(messages: ChatMessage[]): Array<{
  senderName: string;
  count: number;
}> {
  /**
   * 成员到消息数量的聚合表。
   */
  const counts = new Map<string, number>();

  for (const message of messages) {
    const senderName = message.senderName?.trim() || "未知";
    counts.set(senderName, (counts.get(senderName) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([senderName, count]) => ({ senderName, count }))
    .sort((left, right) => right.count - left.count || left.senderName.localeCompare(right.senderName));
}
