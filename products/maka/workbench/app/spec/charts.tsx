/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { platform, Text, View, type JSX } from 'nsh';
import {
  Area,
  Bar,
  Cell,
  Dot,
  Grid as PlotGrid,
  Line,
  Pie,
  Plot,
  PlotAxis,
  type Curve,
} from 'nsh/base/plot';
import { tr } from '../locale';
import { C, captionTextStyle, secondaryTextStyle } from '../ui';
import type { SpecElementRenderContext } from './runtime.tsx';

type SeriesItem = {
  key: string;
  label: string;
  color: string;
};

function chartPalette(): string[] {
  return [C.accent, C.success, C.warning, C.danger, C.accentHover, C.secondary];
}

function resolveSemanticColor(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || !raw) return fallback;
  switch (raw) {
    case 'accent':
      return C.accent;
    case 'success':
      return C.success;
    case 'warning':
      return C.warning;
    case 'danger':
      return C.danger;
    case 'muted':
      return C.muted;
    case 'secondary':
      return C.secondary;
    default:
      return raw;
  }
}

function resolveCurve(raw: unknown): Curve {
  if (raw === 'linear') return 'linear';
  if (raw === 'step') return 'stepAfter';
  return 'natural';
}

function str(raw: unknown, fallback = ''): string {
  return typeof raw === 'string' ? raw : fallback;
}

function parseSeries(raw: unknown): SeriesItem[] {
  const palette = chartPalette();
  if (!Array.isArray(raw)) return [];
  const out: SeriesItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item === 'string' && item) {
      out.push({ key: item, label: item, color: palette[i % palette.length]! });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const key = typeof obj.key === 'string' ? obj.key : '';
    if (!key) continue;
    const label = typeof obj.label === 'string' && obj.label ? obj.label : key;
    const color = resolveSemanticColor(obj.color, palette[i % palette.length]!);
    out.push({ key, label, color });
  }
  return out;
}

function parseRows(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is Record<string, unknown> =>
      item !== null && typeof item === 'object' && !Array.isArray(item),
  );
}

function defaultChartHeight(raw: unknown, fallback = 180): number {
  const requested = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
  const clamped = Math.max(80, Math.min(480, Math.round(requested)));
  return platform.idiom === 'terminal' ? Math.max(64, Math.min(160, clamped)) : clamped;
}

function LegendRow(props: { items: () => readonly { label: string; color: string }[] }) {
  return (
    <If when={props.items().length > 1}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
        <Each of={props.items()} key={(item) => `${item.label}:${item.color}`}>
          {(item) => (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <View
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: item().color,
                }}
              />
              <Text style={{ ...captionTextStyle, color: C.secondary }}>{item().label}</Text>
            </View>
          )}
        </Each>
      </View>
    </If>
  );
}

function ChartFrame(props: {
  title: () => string;
  empty: () => boolean;
  legend?: () => readonly { label: string; color: string }[];
  children: JSX.Element;
}) {
  return (
    <View
      style={{
        width: '100%',
        gap: 8,
        padding: platform.idiom === 'terminal' ? 8 : 12,
        backgroundColor: C.card,
        borderWidth: 1,
        borderColor: C.line,
        borderRadius: platform.idiom === 'terminal' ? 0 : 10,
      }}
    >
      <If when={props.title()}>
        <Text style={{ ...secondaryTextStyle, fontWeight: '600', color: C.text }}>
          {props.title()}
        </Text>
      </If>
      <If when={props.legend}>{props.legend ? <LegendRow items={props.legend} /> : null}</If>
      <If
        when={!props.empty()}
        else={<Text style={{ ...captionTextStyle, color: C.muted }}>{tr('No items')}</Text>}
      >
        {props.children}
      </If>
    </View>
  );
}

export function MiniSparkline(props: {
  values: () => number[];
  width?: () => number;
  height?: () => number;
  color?: () => string;
  label?: () => string;
}) {
  const rows = () => props.values().map((v, idx) => ({ idx, value: v }));
  const w = () => props.width?.() ?? (platform.idiom === 'terminal' ? 96 : 112);
  const h = () => props.height?.() ?? (platform.idiom === 'terminal' ? 32 : 36);
  const stroke = () => props.color?.() ?? C.accent;
  return (
    <If when={rows().length > 0}>
      <Plot
        data={rows()}
        y="value"
        interactive={false}
        accessibilityLabel={props.label?.() || tr('Sparkline')}
        style={{ width: w(), height: h(), flexShrink: 0 }}
      >
        <Line curve="natural" style={{ stroke: stroke(), strokeWidth: 1.75 }} />
      </Plot>
    </If>
  );
}

export function renderSparkline(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const values = () => {
    const raw = p().data;
    if (!Array.isArray(raw)) return [];
    return raw.map(Number).filter(Number.isFinite);
  };
  const label = () => str(p().label);
  const color = () => resolveSemanticColor(p().color, C.accent);
  const width = () =>
    typeof p().width === 'number' && Number.isFinite(p().width)
      ? Math.max(48, Math.round(p().width as number))
      : platform.idiom === 'terminal'
        ? 96
        : 128;
  const height = () =>
    typeof p().height === 'number' && Number.isFinite(p().height)
      ? Math.max(24, Math.round(p().height as number))
      : platform.idiom === 'terminal'
        ? 32
        : 40;

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <If when={label()}>
        <Text style={{ ...captionTextStyle, color: C.secondary }}>{label()}</Text>
      </If>
      <MiniSparkline values={values} width={width} height={height} color={color} label={label} />
    </View>
  );
}

export function renderLineChart(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const rows = () => parseRows(p().data);
  const series = () => parseSeries(p().series ?? p().yKeys);
  const xKey = () => str(p().xKey, 'x');
  const title = () => str(p().title);
  const curve = () => resolveCurve(p().curve);
  const showDots = () => Boolean(p().dots);
  const showGrid = () => p().grid !== false;
  const height = () => defaultChartHeight(p().height);

  return (
    <ChartFrame
      title={title}
      empty={() => rows().length === 0 || series().length === 0}
      legend={series}
    >
      <View style={{ paddingLeft: 36, paddingBottom: 22, paddingRight: 8, paddingTop: 4 }}>
        <Plot
          data={rows()}
          accessibilityLabel={title() || tr('Line chart')}
          crossLineStyle={{ width: 1, backgroundColor: C.line }}
          style={{ width: '100%', height: height() }}
        >
          <If when={showGrid()}>
            <PlotGrid ticks={4} style={{ stroke: C.line, strokeWidth: 1 }} />
          </If>
          <PlotAxis
            placement="left"
            ticks={4}
            labelStyle={{ ...captionTextStyle, fontSize: 11, color: C.muted, paddingRight: 6 }}
          />
          <PlotAxis
            placement="bottom"
            ticks={Math.min(6, Math.max(2, rows().length))}
            format={(val: number) => {
              const row = rows()[Math.round(val)];
              return row ? String(row[xKey()] ?? '') : '';
            }}
            labelStyle={{ ...captionTextStyle, fontSize: 11, color: C.muted, paddingTop: 6 }}
          />
          <Each of={series()} key={(s) => s.key}>
            {(s) => (
              <Line
                y={(row: Record<string, unknown>) => Number(row[s().key] ?? 0)}
                curve={curve()}
                dot={showDots()}
                dotStyle={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: s().color,
                }}
                style={{ stroke: s().color, strokeWidth: 2 }}
              />
            )}
          </Each>
        </Plot>
      </View>
    </ChartFrame>
  );
}

export function renderAreaChart(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const rawRows = () => parseRows(p().data);
  const series = () => parseSeries(p().series);
  const stacked = () => Boolean(p().stacked);
  const rows = () => {
    const base = rawRows();
    const s = series();
    if (!stacked() || s.length <= 1) return base;
    return base.map((row) => {
      const next: Record<string, unknown> = { ...row };
      let running = 0;
      for (const item of s) {
        const y0 = running;
        running += Number(row[item.key] ?? 0) || 0;
        next[`__y0_${item.key}`] = y0;
        next[`__y1_${item.key}`] = running;
      }
      return next;
    });
  };
  const xKey = () => str(p().xKey, 'x');
  const title = () => str(p().title);
  const curve = () => resolveCurve(p().curve);
  const height = () => defaultChartHeight(p().height);

  return (
    <ChartFrame
      title={title}
      empty={() => rows().length === 0 || series().length === 0}
      legend={series}
    >
      <View style={{ paddingLeft: 36, paddingBottom: 22, paddingRight: 8, paddingTop: 4 }}>
        <Plot
          data={rows()}
          yScale={{ type: 'linear' }}
          accessibilityLabel={title() || tr('Area chart')}
          crossLineStyle={{ width: 1, backgroundColor: C.line }}
          style={{ width: '100%', height: height() }}
        >
          <PlotGrid ticks={4} style={{ stroke: C.line, strokeWidth: 1 }} />
          <PlotAxis
            placement="left"
            ticks={4}
            labelStyle={{ ...captionTextStyle, fontSize: 11, color: C.muted, paddingRight: 6 }}
          />
          <PlotAxis
            placement="bottom"
            ticks={Math.min(6, Math.max(2, rows().length))}
            format={(val: number) => {
              const row = rows()[Math.round(val)];
              return row ? String(row[xKey()] ?? '') : '';
            }}
            labelStyle={{ ...captionTextStyle, fontSize: 11, color: C.muted, paddingTop: 6 }}
          />
          <Each of={series()} key={(s) => s.key}>
            {(s) => {
              const y1Accessor = (row: Record<string, unknown>) =>
                stacked() && series().length > 1
                  ? Number(row[`__y1_${s().key}`] ?? 0)
                  : Number(row[s().key] ?? 0);
              const y0Accessor =
                stacked() && series().length > 1
                  ? (row: Record<string, unknown>) => Number(row[`__y0_${s().key}`] ?? 0)
                  : 0;
              return (
                <>
                  <Area
                    y1={y1Accessor}
                    y0={y0Accessor}
                    curve={curve()}
                    style={{ fill: s().color, opacity: 0.22 }}
                  />
                  <Line
                    y={y1Accessor}
                    curve={curve()}
                    style={{ stroke: s().color, strokeWidth: 2 }}
                  />
                </>
              );
            }}
          </Each>
        </Plot>
      </View>
    </ChartFrame>
  );
}

export function renderBarChart(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const rows = () => parseRows(p().data);
  const explicitSeries = () => parseSeries(p().series);
  const series = (): SeriesItem[] => {
    const s = explicitSeries();
    if (s.length > 0) return s;
    return [{ key: 'value', label: tr('Value'), color: C.accent }];
  };
  const xKey = () => {
    if (typeof p().xKey === 'string' && p().xKey) return p().xKey as string;
    const first = rows()[0];
    if (first && 'label' in first) return 'label';
    return 'name';
  };
  const title = () => str(p().title);
  const stacked = () => Boolean(p().stacked);
  const showValues = () => Boolean(p().showValues);
  const height = () => defaultChartHeight(p().height);

  return (
    <ChartFrame
      title={title}
      empty={() => rows().length === 0}
      legend={() => (series().length > 1 ? series() : [])}
    >
      <View style={{ paddingLeft: 36, paddingBottom: 22, paddingRight: 8, paddingTop: 8 }}>
        <Plot
          data={rows()}
          xScale={{ type: 'band', paddingInner: 0.25, paddingOuter: 0.12, groupPadding: 0.1 }}
          accessibilityLabel={title() || tr('Bar chart')}
          style={{ width: '100%', height: height() }}
        >
          <PlotGrid ticks={4} style={{ stroke: C.line, strokeWidth: 1 }} />
          <PlotAxis
            placement="left"
            ticks={4}
            labelStyle={{ ...captionTextStyle, fontSize: 11, color: C.muted, paddingRight: 6 }}
          />
          <PlotAxis
            placement="bottom"
            ticks={Math.min(8, Math.max(1, rows().length))}
            format={(val: number) => {
              const row = rows()[Math.round(val)];
              return row ? String(row[xKey()] ?? '') : '';
            }}
            labelStyle={{ ...captionTextStyle, fontSize: 11, color: C.muted, paddingTop: 6 }}
          />
          <Each of={series()} key={(s) => s.key}>
            {(s) => (
              <Bar
                value={(row: Record<string, unknown>) => Number(row[s().key] ?? 0)}
                stack={stacked() ? 'total' : undefined}
                cornerRadii={{ topLeft: 4, topRight: 4 }}
                label={
                  showValues()
                    ? (row: Record<string, unknown>) => String(row[s().key] ?? '')
                    : undefined
                }
                labelStyle={{
                  ...captionTextStyle,
                  fontSize: 11,
                  color: C.secondary,
                  paddingBottom: 2,
                }}
                style={{ fill: s().color }}
              />
            )}
          </Each>
        </Plot>
      </View>
    </ChartFrame>
  );
}

export function renderPieChart(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const slices = () => {
    const palette = chartPalette();
    const raw = parseRows(p().data);
    return raw
      .map((row, idx) => ({
        label: String(row.label ?? row.name ?? tr('Slice {index}', { index: idx + 1 })),
        value: Math.max(0, Number(row.value ?? 0) || 0),
        color: resolveSemanticColor(row.color, palette[idx % palette.length]!),
      }))
      .filter((s) => s.value > 0);
  };
  const total = () => slices().reduce((sum, s) => sum + s.value, 0);
  const title = () => str(p().title);
  const donut = () => Boolean(p().donut);
  const size = () => defaultChartHeight(p().height, 160);

  return (
    <ChartFrame title={title} empty={() => slices().length === 0}>
      <View
        style={{
          flexDirection: platform.idiom === 'terminal' ? 'column' : 'row',
          alignItems: 'center',
          gap: 16,
        }}
      >
        <Plot
          data={slices()}
          colorScale={{
            type: 'ordinal',
            domain: slices().map((s) => s.label),
            range: slices().map((s) => s.color),
          }}
          accessibilityLabel={title() || tr('Pie chart')}
          style={{ width: size(), height: size(), flexShrink: 0 }}
        >
          <Pie
            value="value"
            color="label"
            innerRadius={donut() ? '55%' : 0}
            outerRadius="92%"
            padAngle={0.03}
            cornerRadius={3}
          />
        </Plot>
        <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
          <Each of={slices()} key={(s) => s.label}>
            {(s) => {
              const pct = () =>
                total() > 0 ? `${Math.round((s().value / total()) * 100)}%` : '0%';
              return (
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 6,
                      minWidth: 0,
                      flex: 1,
                    }}
                  >
                    <View
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        backgroundColor: s().color,
                        flexShrink: 0,
                      }}
                    />
                    <Text
                      style={[
                        { ...captionTextStyle, color: C.text, flexShrink: 1 },
                        { numberOfLines: 1 },
                      ]}
                    >
                      {s().label}
                    </Text>
                  </View>
                  <Text style={{ ...captionTextStyle, color: C.muted }}>
                    {`${s().value} (${pct()})`}
                  </Text>
                </View>
              );
            }}
          </Each>
        </View>
      </View>
    </ChartFrame>
  );
}

export function renderScatterChart(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const rows = () => parseRows(p().data);
  const xKey = () => str(p().xKey, 'x');
  const yKey = () => str(p().yKey, 'y');
  const sizeKey = () => str(p().sizeKey);
  const title = () => str(p().title);
  const height = () => defaultChartHeight(p().height);

  return (
    <ChartFrame title={title} empty={() => rows().length === 0}>
      <View style={{ paddingLeft: 36, paddingBottom: 22, paddingRight: 8, paddingTop: 4 }}>
        <Plot
          data={rows()}
          x={(row: Record<string, unknown>) => Number(row[xKey()] ?? 0)}
          y={(row: Record<string, unknown>) => Number(row[yKey()] ?? 0)}
          xScale={{ type: 'linear' }}
          yScale={{ type: 'linear' }}
          accessibilityLabel={title() || tr('Scatter chart')}
          style={{ width: '100%', height: height() }}
        >
          <PlotGrid ticks={4} style={{ stroke: C.line, strokeWidth: 1 }} />
          <PlotAxis
            placement="left"
            ticks={4}
            labelStyle={{ ...captionTextStyle, fontSize: 11, color: C.muted, paddingRight: 6 }}
          />
          <PlotAxis
            placement="bottom"
            ticks={5}
            labelStyle={{ ...captionTextStyle, fontSize: 11, color: C.muted, paddingTop: 6 }}
          />
          <Dot
            r={sizeKey() ? (row: Record<string, unknown>) => Number(row[sizeKey()] ?? 4) : 4.5}
            rScale={sizeKey() ? { type: 'sqrt', range: [3, 12] } : undefined}
            style={{ fill: C.accent, opacity: 0.85 }}
          />
        </Plot>
      </View>
    </ChartFrame>
  );
}

export function renderHeatmap(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const xLabels = () => (Array.isArray(p().xLabels) ? (p().xLabels as unknown[]).map(String) : []);
  const yLabels = () => (Array.isArray(p().yLabels) ? (p().yLabels as unknown[]).map(String) : []);
  const cells = () => {
    const xs = xLabels();
    const ys = yLabels();
    const matrix = Array.isArray(p().values) ? (p().values as unknown[]) : [];
    const flat: Array<{ x: string; y: string; value: number }> = [];
    for (let r = 0; r < ys.length; r++) {
      const row = Array.isArray(matrix[r]) ? (matrix[r] as unknown[]) : [];
      for (let c = 0; c < xs.length; c++) {
        const val = Number(row[c] ?? 0);
        flat.push({
          x: xs[c]!,
          y: ys[r]!,
          value: Number.isFinite(val) ? val : 0,
        });
      }
    }
    return flat;
  };
  const title = () => str(p().title);
  const height = () => defaultChartHeight(p().height, Math.max(120, yLabels().length * 36));

  return (
    <ChartFrame title={title} empty={() => cells().length === 0}>
      <View style={{ paddingLeft: 56, paddingBottom: 22, paddingRight: 8, paddingTop: 4 }}>
        <Plot
          data={cells()}
          xScale={{ type: 'band', domain: xLabels(), paddingInner: 0.08 }}
          yScale={{ type: 'band', domain: yLabels(), paddingInner: 0.08 }}
          colorScale={{ type: 'sequential', range: [C.cardRaised, C.accent] }}
          accessibilityLabel={title() || tr('Heatmap')}
          style={{ width: '100%', height: height() }}
        >
          <PlotAxis
            placement="left"
            labelStyle={{ ...captionTextStyle, fontSize: 11, color: C.muted, paddingRight: 6 }}
          />
          <PlotAxis
            placement="bottom"
            labelStyle={{ ...captionTextStyle, fontSize: 11, color: C.muted, paddingTop: 6 }}
          />
          <Cell
            x="x"
            y="y"
            value="value"
            cornerRadii={3}
            label={(d: { x: string; y: string; value: number }) => String(d.value)}
            labelStyle={{ ...captionTextStyle, fontSize: 11, color: C.text }}
          />
        </Plot>
      </View>
    </ChartFrame>
  );
}
