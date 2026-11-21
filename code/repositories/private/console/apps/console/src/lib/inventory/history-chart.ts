export const HISTORY_CHART_WIDTH = 640;
export const HISTORY_CHART_HEIGHT = 220;
export const HISTORY_CHART_PADDING = 28;

export type HistoryChartTone = "stock" | "price";

export function summarizeSeries(values: number[]) {
  if (values.length === 0) {
    return null;
  }

  return {
    min: Math.min(...values),
    max: Math.max(...values),
    latest: values.at(-1) ?? 0,
  };
}

export function buildPolylinePoints(values: number[]): string {
  if (values.length === 0) {
    return "";
  }

  const summary = summarizeSeries(values);
  if (!summary) {
    return "";
  }

  const span = summary.max - summary.min || 1;
  const innerWidth = HISTORY_CHART_WIDTH - HISTORY_CHART_PADDING * 2;
  const innerHeight = HISTORY_CHART_HEIGHT - HISTORY_CHART_PADDING * 2;

  return values
    .map((value, index) => {
      const x =
        HISTORY_CHART_PADDING + (index * innerWidth) / Math.max(values.length - 1, 1);
      const y = HISTORY_CHART_HEIGHT - HISTORY_CHART_PADDING - ((value - summary.min) / span) * innerHeight;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export function formatHistoryValue(value: number, tone: HistoryChartTone): string {
  return tone === "price" ? `￥${value}` : String(value);
}
