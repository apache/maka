import {
  buildPolylinePoints,
  formatHistoryValue,
  HISTORY_CHART_HEIGHT,
  HISTORY_CHART_PADDING,
  HISTORY_CHART_WIDTH,
  summarizeSeries,
  type HistoryChartTone,
} from "@/lib/inventory/history-chart";

type HistoryChartProps = {
  title: string;
  values: number[];
  times: string[];
  tone: HistoryChartTone;
};

const toneColor: Record<HistoryChartTone, string> = {
  stock: "#44403c",
  price: "#1c1917",
};

export function HistoryChart({ title, values, times, tone }: HistoryChartProps) {
  const summary = summarizeSeries(values);
  if (!summary) {
    return (
      <article className="rounded-xl bg-card p-5 shadow-sm">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-6 text-sm text-muted-foreground">暂无历史数据</p>
      </article>
    );
  }

  const color = toneColor[tone];
  const points = buildPolylinePoints(values);

  return (
    <article className="rounded-xl bg-card p-5 shadow-sm">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div>
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="text-xs text-muted-foreground">
            {times[0]} 至 {times.at(-1)}
          </p>
        </div>
        <div className="flex flex-wrap gap-3 text-sm">
          <span>
            最低 <strong>{formatHistoryValue(summary.min, tone)}</strong>
          </span>
          <span>
            最高 <strong>{formatHistoryValue(summary.max, tone)}</strong>
          </span>
          <span>
            最新 <strong>{formatHistoryValue(summary.latest, tone)}</strong>
          </span>
        </div>
      </div>
      <svg
        className="mt-5 h-56 w-full overflow-visible"
        role="img"
        viewBox={`0 0 ${HISTORY_CHART_WIDTH} ${HISTORY_CHART_HEIGHT}`}
        aria-label={`${title}历史曲线图`}
      >
        <line
          x1={HISTORY_CHART_PADDING}
          y1={HISTORY_CHART_HEIGHT - HISTORY_CHART_PADDING}
          x2={HISTORY_CHART_WIDTH - HISTORY_CHART_PADDING}
          y2={HISTORY_CHART_HEIGHT - HISTORY_CHART_PADDING}
          stroke="#e7e5e4"
        />
        <polyline
          fill="none"
          points={points}
          stroke={color}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="4"
        />
        {points.split(" ").map((point, index) => {
          const [x, y] = point.split(",");
          return (
            <circle
              key={`${values[index]}-${index}`}
              cx={x}
              cy={y}
              fill="white"
              r="4"
              stroke={color}
              strokeWidth="3"
            />
          );
        })}
      </svg>
    </article>
  );
}
