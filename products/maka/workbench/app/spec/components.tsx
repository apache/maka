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

import {
  cleanup,
  context,
  platform,
  Scroll,
  signal,
  Text,
  View,
  windowSize,
  type JSX,
  type ViewRef,
} from 'nsh';
import { Button, Input, Popover, Select, Slider, TextView, Tooltip } from 'nsh/base';
import { ChoiceIndicator } from '../ChoiceIndicator';
import { Icon } from '../Icon';
import { CodeBlockAction, codeBlockActions, codeBlockStyles } from '../codeBlockLook';
import { tr } from '../locale';
import { MarkdownImageView } from '../MarkdownImage';
import { DialogFooter, DialogHeader, ModalDialog } from '../ModalDialog';
import {
  bodyTextStyle,
  C,
  captionTextStyle,
  codeTextStyle,
  controlDisabledStyle,
  controlFocusStyle,
  controlHoverStyle,
  controlStyle,
  floatingStyle,
  inputBorderRadius,
  inputTextStyle,
  menuDetailTextStyle,
  menuRowStyle,
  quietActiveStyle,
  quietFocusStyle,
  quietHoverStyle,
  richTooltipStyle,
  secondaryTextStyle,
  tooltipStyle,
  tooltipTextStyle,
} from '../ui';
import {
  MiniSparkline,
  renderAreaChart,
  renderBarChart,
  renderHeatmap,
  renderLineChart,
  renderPieChart,
  renderScatterChart,
  renderSparkline,
} from './charts.tsx';
import {
  useBoundField,
  useSpecRuntime,
  type SpecComponentRegistry,
  type SpecElementRenderContext,
} from './runtime.tsx';

const terminal = platform.idiom === 'terminal';

const ActiveTabCtx = context<(() => string) | null>(null);

function resolveGap(raw: unknown, fallback = 12): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, raw);
  switch (raw) {
    case 'none':
      return 0;
    case 'xs':
      return 4;
    case 'sm':
      return 8;
    case 'md':
      return 12;
    case 'lg':
      return 20;
    default:
      return fallback;
  }
}

function resolvePadding(raw: unknown, fallback = 14): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, raw);
  switch (raw) {
    case 'none':
      return 0;
    case 'sm':
      return terminal ? 6 : 10;
    case 'md':
      return terminal ? 8 : 14;
    case 'lg':
      return terminal ? 12 : 20;
    default:
      return terminal ? 8 : fallback;
  }
}

type NormalizedOption = {
  label: string;
  value: string;
  description?: string;
  disabled?: boolean;
};

function normalizeOptions(raw: unknown): NormalizedOption[] {
  if (!Array.isArray(raw)) return [];
  const out: NormalizedOption[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      out.push({ label: entry, value: entry });
    } else if (entry && typeof entry === 'object') {
      const obj = entry as Record<string, unknown>;
      const value = String(obj.value ?? obj.label ?? '');
      const label = String(obj.label ?? value);
      out.push({
        label,
        value,
        description: typeof obj.description === 'string' ? obj.description : undefined,
        disabled: Boolean(obj.disabled),
      });
    }
  }
  return out;
}

function FieldMessages(props: { helper?: () => string; errors: () => string[] }) {
  return (
    <>
      <If when={props.errors().length > 0}>
        <Text style={{ ...captionTextStyle, color: C.danger }}>{props.errors()[0]}</Text>
      </If>
      <If when={props.errors().length === 0 && Boolean(props.helper?.())}>
        <Text style={{ ...captionTextStyle, color: C.muted }}>{props.helper?.()}</Text>
      </If>
    </>
  );
}

function renderCard(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const title = () => {
    const raw = p().title;
    return typeof raw === 'string' ? raw : '';
  };
  const description = () => {
    if (typeof p().description === 'string' && p().description) return p().description as string;
    if (typeof p().subtitle === 'string' && p().subtitle) return p().subtitle as string;
    return '';
  };
  const pad = () => resolvePadding(p().padding);

  return (
    <View
      style={{
        width: '100%',
        minWidth: 0,
        padding: pad(),
        gap: 12,
        backgroundColor: C.card,
        borderWidth: 1,
        borderColor: C.line,
        borderRadius: terminal ? 0 : 12,
      }}
    >
      <If when={title() || description() || ctx.hasSlot('header')}>
        <View style={{ gap: 4 }}>
          <If when={title()}>
            <Text style={{ ...bodyTextStyle, fontWeight: '600', color: C.text }}>{title()}</Text>
          </If>
          <If when={description()}>
            <Text style={{ ...captionTextStyle, color: C.muted }}>{description()}</Text>
          </If>
          <If when={ctx.hasSlot('header')}>{ctx.renderSlot('header')}</If>
        </View>
      </If>
      {ctx.children()}
      <If when={ctx.hasSlot('footer')}>
        <View style={{ paddingTop: 8, borderTopWidth: 1, borderTopColor: C.line }}>
          {ctx.renderSlot('footer')}
        </View>
      </If>
    </View>
  );
}

function renderStack(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const horizontal = () => p().direction === 'horizontal';
  const align = () => {
    switch (p().align) {
      case 'start':
        return 'flex-start' as const;
      case 'center':
        return 'center' as const;
      case 'end':
        return 'flex-end' as const;
      case 'baseline':
        return 'baseline' as const;
      default:
        return 'stretch' as const;
    }
  };
  const justify = () => {
    switch (p().justify) {
      case 'center':
        return 'center' as const;
      case 'end':
        return 'flex-end' as const;
      case 'between':
        return 'space-between' as const;
      case 'around':
        return 'space-around' as const;
      default:
        return 'flex-start' as const;
    }
  };

  return (
    <View
      style={{
        width: horizontal() ? undefined : '100%',
        minWidth: 0,
        flexDirection: horizontal() ? 'row' : 'column',
        gap: resolveGap(p().gap, 10),
        alignItems: align(),
        justifyContent: justify(),
        flexWrap: p().wrap ? 'wrap' : 'nowrap',
      }}
    >
      {ctx.children()}
    </View>
  );
}

function renderGrid(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const cols = () => {
    const raw = typeof p().columns === 'number' ? Math.round(p().columns as number) : 2;
    const clamped = Math.max(1, Math.min(6, raw));
    if (terminal && windowSize().width < 720) return 1;
    return clamped;
  };
  const gap = () => resolveGap(p().gap, 12);

  return (
    <View
      style={{
        width: '100%',
        minWidth: 0,
        display: 'grid',
        gridTemplateColumns: `repeat(${cols()}, minmax(0, 1fr))`,
        gap: gap(),
      }}
    >
      {ctx.children()}
    </View>
  );
}

function renderBox(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  return (
    <View
      style={{
        minWidth: 0,
        flexDirection: p().direction === 'row' ? 'row' : 'column',
        gap: typeof p().gap === 'number' ? (p().gap as number) : 8,
        padding: typeof p().padding === 'number' ? (p().padding as number) : undefined,
        paddingHorizontal: typeof p().paddingX === 'number' ? (p().paddingX as number) : undefined,
        paddingVertical: typeof p().paddingY === 'number' ? (p().paddingY as number) : undefined,
        alignItems:
          (p().alignItems as 'flex-start' | 'center' | 'flex-end' | 'stretch') ?? 'stretch',
        justifyContent:
          (p().justifyContent as
            | 'flex-start'
            | 'center'
            | 'flex-end'
            | 'space-between'
            | 'space-around') ?? 'flex-start',
        flexGrow: typeof p().grow === 'number' ? (p().grow as number) : undefined,
        ...(p().bordered
          ? {
              borderWidth: 1,
              borderColor: C.line,
              borderRadius: terminal ? 0 : 8,
              backgroundColor: C.card,
            }
          : {}),
      }}
    >
      {ctx.children()}
    </View>
  );
}

function renderSpacer(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const size = () => (typeof p().size === 'number' ? Math.max(0, p().size as number) : 12);
  return (
    <View
      style={
        p().flex
          ? { flex: 1, minWidth: 4, minHeight: 4 }
          : { width: size(), height: size(), flexShrink: 0 }
      }
    />
  );
}

function renderNewline(ctx: SpecElementRenderContext): JSX.Element {
  const count = () => {
    const raw = ctx.props().count;
    return typeof raw === 'number' && Number.isFinite(raw) ? Math.max(1, Math.round(raw)) : 1;
  };
  return <View style={{ height: count() * (terminal ? 14 : 12), width: '100%' }} />;
}

function renderSeparator(ctx: SpecElementRenderContext): JSX.Element {
  const vertical = () => ctx.props().orientation === 'vertical';
  return (
    <View
      style={
        vertical()
          ? { width: 1, alignSelf: 'stretch', backgroundColor: C.line }
          : { width: '100%', height: 1, backgroundColor: C.line }
      }
    />
  );
}

function renderDivider(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const title = () => {
    const raw = p().title;
    return typeof raw === 'string' ? raw : '';
  };
  return (
    <If when={title()} else={renderSeparator(ctx)}>
      <View style={{ width: '100%', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ flex: 1, height: 1, backgroundColor: C.line }} />
        <Text style={{ ...captionTextStyle, color: C.muted }}>{title()}</Text>
        <View style={{ flex: 1, height: 1, backgroundColor: C.line }} />
      </View>
    </If>
  );
}

function renderHeading(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const level = () => String(p().level ?? 'h2');
  const size = () => {
    if (terminal) return 14;
    switch (level()) {
      case 'h1':
        return 20;
      case 'h2':
        return 17;
      case 'h3':
        return 15;
      default:
        return 14;
    }
  };
  return (
    <Text
      role="header"
      style={{
        fontSize: size(),
        lineHeight: terminal ? 16 : size() + 6,
        fontWeight: '700',
        color: C.text,
      }}
    >
      {String(p().text ?? '')}
    </Text>
  );
}

function renderText(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const color = () => {
    switch (p().color) {
      case 'secondary':
        return C.secondary;
      case 'muted':
        return C.muted;
      case 'accent':
        return C.accent;
      case 'success':
        return C.success;
      case 'warning':
        return C.warning;
      case 'danger':
        return C.danger;
      default:
        return p().variant === 'muted' || p().variant === 'caption' ? C.muted : C.text;
    }
  };
  const base = () => {
    switch (p().variant) {
      case 'caption':
      case 'muted':
        return captionTextStyle;
      case 'code':
        return codeTextStyle;
      case 'lead':
        return { fontSize: terminal ? 14 : 16, lineHeight: terminal ? 16 : 24 };
      default:
        return secondaryTextStyle;
    }
  };

  return (
    <Text
      style={[
        {
          ...base(),
          color: color(),
          fontWeight: p().bold ? '600' : undefined,
          fontStyle: p().italic ? 'italic' : undefined,
          textAlign: (p().align as 'left' | 'center' | 'right') ?? undefined,
          ...(p().variant === 'code'
            ? { backgroundColor: C.cardRaised, paddingHorizontal: 4, borderRadius: 4 }
            : {}),
        },
        p().truncate ? { numberOfLines: 1, textOverflow: 'ellipsis' } : {},
      ]}
    >
      {String(p().text ?? '')}
    </Text>
  );
}

function renderMarkdown(ctx: SpecElementRenderContext): JSX.Element {
  const runtime = useSpecRuntime();
  const content = () => String(ctx.props().content ?? '');
  return (
    <TextView
      markdown={content()}
      selectable
      options={{ preserveLineBreaks: true }}
      onLinkPress={(e) => {
        const target = e.target;
        if (runtime.openLink && (!target || target.isLive())) {
          void runtime.openLink(e.url, () => (target ? target.focus() : false));
        }
      }}
      renderImage={(context) =>
        runtime.sessionId ? (
          <MarkdownImageView
            image={() => context.image}
            sessionId={runtime.sessionId}
            linked={context.linked}
            flow={context.flow}
            lineHeight={context.lineHeight}
          />
        ) : (
          <Text style={{ ...captionTextStyle, color: C.secondary }}>
            {context.image.alt || context.image.src}
          </Text>
        )
      }
      styles={{
        root: { ...secondaryTextStyle, color: C.text },
        paragraph: secondaryTextStyle,
        link: { color: C.accent },
        code: { color: C.text, backgroundColor: C.cardRaised, borderRadius: 4 },
      }}
    />
  );
}

function renderCodeBlock(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  return (
    <TextView
      document={{
        blocks: [
          {
            type: 'codeBlock',
            language: typeof p().language === 'string' ? (p().language as string) : undefined,
            code: String(p().code ?? ''),
          },
        ],
      }}
      selectable
      renderCodeBlockAction={(action) => <CodeBlockAction action={action} />}
      codeBlockActions={codeBlockActions()}
      styles={{
        ...codeBlockStyles(C.text, terminal ? 0 : 8),
        codeBlock: {
          backgroundColor: C.background,
          borderColor: C.line,
          borderRadius: terminal ? 0 : 8,
        },
      }}
    />
  );
}

function renderBadge(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const tone = () => {
    switch (p().variant) {
      case 'success':
        return { fg: C.success, bg: C.added, border: C.success };
      case 'warning':
        return { fg: C.warning, bg: C.cardRaised, border: C.warning };
      case 'danger':
      case 'destructive':
        return { fg: C.danger, bg: C.removed, border: C.danger };
      case 'info':
        return { fg: C.accent, bg: C.cardRaised, border: C.accent };
      case 'outline':
        return { fg: C.secondary, bg: 'transparent', border: C.line };
      case 'secondary':
        return { fg: C.secondary, bg: C.cardRaised, border: C.line };
      default:
        return { fg: C.accent, bg: C.cardRaised, border: C.line };
    }
  };

  return (
    <View
      style={{
        alignSelf: 'flex-start',
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: terminal ? 0 : 999,
        backgroundColor: tone().bg,
        borderWidth: 1,
        borderColor: tone().border,
      }}
    >
      <Text style={{ ...captionTextStyle, fontSize: 12, fontWeight: '500', color: tone().fg }}>
        {String(p().text ?? '')}
      </Text>
    </View>
  );
}

function renderStatusLine(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const iconInfo = () => {
    switch (p().status) {
      case 'success':
        return { icon: 'statusSuccess' as const, color: C.success };
      case 'warning':
        return { icon: 'statusStopped' as const, color: C.warning };
      case 'error':
        return { icon: 'statusError' as const, color: C.danger };
      case 'pending':
        return { icon: 'statusPending' as const, color: C.muted };
      default:
        return { icon: 'statusRecorded' as const, color: C.accent };
    }
  };

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <Icon name={iconInfo().icon} color={iconInfo().color} />
      <Text style={[{ ...secondaryTextStyle, color: C.text, flex: 1 }, { numberOfLines: 1 }]}>
        {String(p().label ?? '')}
      </Text>
      <If when={typeof p().detail === 'string' && p().detail}>
        <Text style={{ ...captionTextStyle, color: C.muted }}>{String(p().detail)}</Text>
      </If>
    </View>
  );
}

function renderAlert(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const accentColor = () => {
    switch (p().type) {
      case 'success':
        return C.success;
      case 'warning':
        return C.warning;
      case 'error':
      case 'destructive':
        return C.danger;
      default:
        return C.accent;
    }
  };

  return (
    <View
      style={{
        width: '100%',
        padding: terminal ? 8 : 12,
        gap: 4,
        backgroundColor: C.card,
        borderWidth: 1,
        borderColor: accentColor(),
        borderRadius: terminal ? 0 : 10,
      }}
    >
      <Text style={{ ...secondaryTextStyle, fontWeight: '600', color: accentColor() }}>
        {String(p().title ?? '')}
      </Text>
      <If when={typeof p().description === 'string' && p().description}>
        <Text style={{ ...captionTextStyle, color: C.secondary }}>{String(p().description)}</Text>
      </If>
    </View>
  );
}

function renderCallout(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const stripe = () => {
    switch (p().type) {
      case 'tip':
        return C.success;
      case 'warning':
        return C.warning;
      case 'caution':
        return C.danger;
      default:
        return C.accent;
    }
  };

  return (
    <View
      style={{
        width: '100%',
        paddingLeft: 12,
        paddingRight: 12,
        paddingVertical: 8,
        gap: 4,
        backgroundColor: C.card,
        borderLeftWidth: 3,
        borderLeftColor: stripe(),
        borderRadius: terminal ? 0 : 6,
      }}
    >
      <If when={typeof p().title === 'string' && p().title}>
        <Text style={{ ...captionTextStyle, fontWeight: '600', color: stripe() }}>
          {String(p().title)}
        </Text>
      </If>
      <Text style={{ ...secondaryTextStyle, color: C.secondary }}>{String(p().content ?? '')}</Text>
    </View>
  );
}

function renderMetric(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const trendColor = () => {
    switch (p().trend) {
      case 'up':
        return C.success;
      case 'down':
        return C.danger;
      default:
        return C.muted;
    }
  };
  const spark = () =>
    Array.isArray(p().sparkline)
      ? (p().sparkline as unknown[]).map(Number).filter(Number.isFinite)
      : [];

  return (
    <View
      style={{
        padding: terminal ? 8 : 12,
        gap: 6,
        backgroundColor: C.card,
        borderWidth: 1,
        borderColor: C.line,
        borderRadius: terminal ? 0 : 10,
        minWidth: 0,
      }}
    >
      <Text style={{ ...captionTextStyle, color: C.muted }}>{String(p().label ?? '')}</Text>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <View style={{ gap: 2, minWidth: 0, flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <Text
              style={{
                fontSize: terminal ? 14 : 22,
                lineHeight: terminal ? 16 : 28,
                fontWeight: '700',
                color: C.text,
              }}
            >
              {String(p().value ?? '')}
            </Text>
            <If when={typeof p().change === 'string' && p().change}>
              <Text style={{ ...captionTextStyle, fontWeight: '600', color: trendColor() }}>
                {String(p().change)}
              </Text>
            </If>
          </View>
          <If when={typeof p().caption === 'string' && p().caption}>
            <Text style={{ ...captionTextStyle, color: C.muted }}>{String(p().caption)}</Text>
          </If>
        </View>
        <If when={spark().length > 1}>
          <MiniSparkline values={spark} color={trendColor} />
        </If>
      </View>
    </View>
  );
}

function renderKeyValue(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const rows = () => {
    if (Array.isArray(p().items)) {
      return (p().items as unknown[])
        .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object')
        .map((r) => ({ key: String(r.key ?? ''), value: String(r.value ?? '') }));
    }
    if (p().label !== undefined) {
      return [{ key: String(p().label ?? ''), value: String(p().value ?? '') }];
    }
    return [];
  };

  return (
    <View style={{ width: '100%', gap: 2 }}>
      <Each of={rows()} key={(r) => r.key}>
        {(r, index) => (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 12,
              paddingVertical: 4,
              paddingHorizontal: p().striped ? 8 : 0,
              backgroundColor: p().striped && index() % 2 === 1 ? C.cardRaised : undefined,
              borderRadius: terminal ? 0 : 4,
            }}
          >
            <Text style={{ ...captionTextStyle, color: C.muted, flexShrink: 0 }}>{r().key}</Text>
            <Text
              style={{ ...secondaryTextStyle, color: C.text, textAlign: 'right', flexShrink: 1 }}
            >
              {r().value}
            </Text>
          </View>
        )}
      </Each>
    </View>
  );
}

type TableCol = {
  key: string;
  header: string;
  align?: 'left' | 'center' | 'right';
  width?: number;
  sortable?: boolean;
};

const SORTABLE_NUMBER_RE =
  /^\s*([+-])?[$€£¥]?\s*(\d+(?:\.\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?)\s*(?:%|ms|s|B|KB|MB|GB|TB)?\s*$/i;

function parseSortableNumber(raw: string): number | null {
  const match = SORTABLE_NUMBER_RE.exec(raw);
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  const num = Number(match[2]!.replace(/,/g, ''));
  return Number.isFinite(num) ? sign * num : null;
}

function compareNaturalText(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g;
  const aParts = a.match(re) ?? [];
  const bParts = b.match(re) ?? [];
  const len = Math.min(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const ap = aParts[i]!;
    const bp = bParts[i]!;
    const aDigits = ap.charCodeAt(0) >= 48 && ap.charCodeAt(0) <= 57;
    const bDigits = bp.charCodeAt(0) >= 48 && bp.charCodeAt(0) <= 57;
    if (aDigits && bDigits) {
      const diff = Number(ap) - Number(bp);
      if (diff !== 0) return diff;
      if (ap.length !== bp.length) return ap.length - bp.length;
    } else {
      const al = ap.toLowerCase();
      const bl = bp.toLowerCase();
      if (al !== bl) return al < bl ? -1 : 1;
    }
  }
  if (aParts.length !== bParts.length) return aParts.length - bParts.length;
  return a === b ? 0 : a < b ? -1 : 1;
}

function renderTable(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const sortCol = signal<number | null>(null);
  const sortAsc = signal(true);

  const columns = (): TableCol[] => {
    const raw = Array.isArray(p().columns) ? (p().columns as unknown[]) : [];
    return raw.map((col, idx) => {
      if (typeof col === 'string') return { key: String(idx), header: col };
      if (col && typeof col === 'object') {
        const obj = col as Record<string, unknown>;
        return {
          key: String(obj.key ?? idx),
          header: String(obj.header ?? obj.label ?? obj.key ?? ''),
          align: (obj.align as 'left' | 'center' | 'right') ?? undefined,
          width: typeof obj.width === 'number' ? (obj.width as number) : undefined,
          sortable: typeof obj.sortable === 'boolean' ? obj.sortable : undefined,
        };
      }
      return { key: String(idx), header: '' };
    });
  };

  const isColumnSortable = (col: TableCol | undefined): boolean =>
    Boolean(col && (col.sortable ?? Boolean(p().sortable)));

  const normalizedRows = (): string[][] => {
    const cols = columns();
    const rawSource = p().rows ?? p().data;
    const rawRows = Array.isArray(rawSource) ? (rawSource as unknown[]) : [];
    const base = rawRows.map((row) => {
      if (Array.isArray(row)) {
        return cols.map((_, idx) => String(row[idx] ?? ''));
      }
      if (row && typeof row === 'object') {
        const obj = row as Record<string, unknown>;
        return cols.map((c) => String(obj[c.key] ?? ''));
      }
      return cols.map(() => '');
    });

    const idx = sortCol();
    if (idx === null || idx < 0 || idx >= cols.length || !isColumnSortable(cols[idx])) {
      return base;
    }
    const dir = sortAsc() ? 1 : -1;
    return [...base].sort((a, b) => {
      const av = a[idx] ?? '';
      const bv = b[idx] ?? '';
      const an = parseSortableNumber(av);
      const bn = parseSortableNumber(bv);
      if (an !== null && bn !== null) {
        return (an - bn) * dir;
      }
      return compareNaturalText(av, bv) * dir;
    });
  };

  return (
    <View style={{ width: '100%', gap: 6 }}>
      <View
        style={{
          width: '100%',
          borderWidth: 1,
          borderColor: C.line,
          borderRadius: terminal ? 0 : 10,
          overflow: 'hidden',
          backgroundColor: C.card,
        }}
      >
        <View
          style={{
            flexDirection: 'row',
            backgroundColor: C.cardRaised,
            borderBottomWidth: 1,
            borderBottomColor: C.line,
          }}
        >
          <Each of={columns()} key={(c) => `${c.key}:${c.header}`}>
            {(col, idx) => {
              const colSortable = () => isColumnSortable(col());
              const cellStyle = () => ({
                ...(col().width ? { width: col().width, flexShrink: 0 } : { flex: 1, minWidth: 0 }),
                paddingHorizontal: terminal ? 6 : 12,
                paddingVertical: terminal ? 4 : 8,
                flexDirection: 'row' as const,
                alignItems: 'center' as const,
                justifyContent:
                  col().align === 'right'
                    ? ('flex-end' as const)
                    : col().align === 'center'
                      ? ('center' as const)
                      : ('flex-start' as const),
                gap: 4,
              });
              return (
                <If
                  when={colSortable()}
                  else={
                    <View style={cellStyle()}>
                      <Text style={{ ...captionTextStyle, fontWeight: '600', color: C.text }}>
                        {col().header}
                      </Text>
                    </View>
                  }
                >
                  <Button
                    accessibilityLabel={col().header}
                    onPress={() => {
                      const current = sortCol();
                      if (current === idx()) {
                        sortAsc.set(!sortAsc());
                      } else {
                        sortCol.set(idx());
                        sortAsc.set(true);
                      }
                    }}
                    style={cellStyle()}
                    hoverStyle={quietHoverStyle()}
                    focusStyle={quietFocusStyle()}
                  >
                    <Text style={{ ...captionTextStyle, fontWeight: '600', color: C.text }}>
                      {col().header}
                    </Text>
                    <If when={sortCol() === idx()}>
                      <Text style={{ ...captionTextStyle, color: C.accent }}>
                        {sortAsc() ? '↑' : '↓'}
                      </Text>
                    </If>
                  </Button>
                </If>
              );
            }}
          </Each>
        </View>
        <Each of={normalizedRows()} key={(row, idx) => `${idx}:${row.join('|')}`}>
          {(row, rIdx) => (
            <View
              style={{
                flexDirection: 'row',
                borderTopWidth: rIdx() > 0 ? 1 : 0,
                borderTopColor: C.line,
                backgroundColor: p().striped && rIdx() % 2 === 1 ? C.surface : undefined,
              }}
            >
              <Each of={columns()} key={(c) => c.key}>
                {(col, cIdx) => (
                  <View
                    style={{
                      ...(col().width
                        ? { width: col().width, flexShrink: 0 }
                        : { flex: 1, minWidth: 0 }),
                      paddingHorizontal: terminal ? 6 : 12,
                      paddingVertical: terminal ? 4 : 8,
                    }}
                  >
                    <Text
                      style={{
                        ...secondaryTextStyle,
                        color: C.text,
                        textAlign: col().align ?? 'left',
                      }}
                    >
                      {row()[cIdx()] ?? ''}
                    </Text>
                  </View>
                )}
              </Each>
            </View>
          )}
        </Each>
      </View>
      <If when={typeof p().caption === 'string' && p().caption}>
        <Text style={{ ...captionTextStyle, color: C.muted }}>{String(p().caption)}</Text>
      </If>
    </View>
  );
}

function renderList(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const items = () =>
    Array.isArray(p().items) ? (p().items as unknown[]).map((i) => String(i ?? '')) : [];
  const ordered = () => Boolean(p().ordered);

  return (
    <View style={{ width: '100%', gap: p().divided ? 0 : 6 }}>
      <Each of={items()} key={(item, idx) => `${idx}:${item}`}>
        {(item, idx) => (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'flex-start',
              gap: 8,
              paddingVertical: p().divided ? 6 : 0,
              borderTopWidth: p().divided && idx() > 0 ? 1 : 0,
              borderTopColor: C.line,
            }}
          >
            <Text style={{ ...secondaryTextStyle, color: C.muted, flexShrink: 0 }}>
              {ordered() ? `${idx() + 1}.` : '•'}
            </Text>
            <Text style={{ ...secondaryTextStyle, color: C.text, flex: 1 }}>{item()}</Text>
          </View>
        )}
      </Each>
      {ctx.children()}
    </View>
  );
}

function renderListItem(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const hasPress = () => Boolean(ctx.element().on && 'press' in ctx.element().on!);
  const body = () => (
    <>
      <If when={typeof p().leading === 'string' && p().leading}>
        <Text style={{ ...captionTextStyle, color: C.accent, flexShrink: 0 }}>
          {String(p().leading)}
        </Text>
      </If>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={{ ...secondaryTextStyle, color: C.text, fontWeight: '500' }}>
          {String(p().title ?? '')}
        </Text>
        <If when={typeof p().subtitle === 'string' && p().subtitle}>
          <Text style={{ ...captionTextStyle, color: C.muted }}>{String(p().subtitle)}</Text>
        </If>
      </View>
      <If when={typeof p().trailing === 'string' && p().trailing}>
        <Text style={{ ...captionTextStyle, color: C.secondary, flexShrink: 0 }}>
          {String(p().trailing)}
        </Text>
      </If>
    </>
  );

  return hasPress() ? (
    <Button
      accessibilityLabel={String(p().title ?? '')}
      onPress={() => ctx.emit('press')}
      style={{
        width: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 6,
        paddingHorizontal: 8,
        borderRadius: terminal ? 0 : 8,
      }}
      hoverStyle={quietHoverStyle()}
      activeStyle={quietActiveStyle()}
      focusStyle={quietFocusStyle()}
    >
      {body()}
    </Button>
  ) : (
    <View
      style={{
        width: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 4,
      }}
    >
      {body()}
    </View>
  );
}

function renderTimeline(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const items = () => {
    const raw = Array.isArray(p().items) ? (p().items as unknown[]) : [];
    return raw
      .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object')
      .map((r) => ({
        title: String(r.title ?? ''),
        description: typeof r.description === 'string' ? r.description : '',
        time: typeof r.time === 'string' ? r.time : '',
        status: String(r.status ?? 'completed'),
      }));
  };

  return (
    <View style={{ width: '100%', gap: 10 }}>
      <Each of={items()} key={(it, idx) => `${idx}:${it.title}`}>
        {(it) => {
          const dotColor = () => {
            switch (it().status) {
              case 'completed':
                return C.success;
              case 'active':
                return C.accent;
              case 'error':
                return C.danger;
              default:
                return C.muted;
            }
          };
          return (
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
              <View
                style={{
                  width: 10,
                  height: 10,
                  marginTop: 5,
                  borderRadius: 5,
                  backgroundColor: dotColor(),
                  flexShrink: 0,
                }}
              />
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                  <Text style={{ ...secondaryTextStyle, fontWeight: '600', color: C.text }}>
                    {it().title}
                  </Text>
                  <If when={it().time}>
                    <Text style={{ ...captionTextStyle, color: C.muted }}>{it().time}</Text>
                  </If>
                </View>
                <If when={it().description}>
                  <Text style={{ ...captionTextStyle, color: C.secondary }}>
                    {it().description}
                  </Text>
                </If>
              </View>
            </View>
          );
        }}
      </Each>
    </View>
  );
}

function ProgressRow(props: {
  ratio: () => number;
  label: () => string;
  showValue: () => boolean;
  color: () => string;
}) {
  const clamped = () => Math.max(0, Math.min(1, props.ratio()));
  const pct = () => Math.round(clamped() * 100);
  const terminalBar = () => {
    const slots = 20;
    const filled = Math.round(clamped() * slots);
    return `${'█'.repeat(filled)}${'░'.repeat(slots - filled)}`;
  };

  return (
    <View style={{ width: '100%', gap: 4 }}>
      <If when={props.label() || props.showValue()}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
          <Text style={{ ...captionTextStyle, color: C.secondary }}>{props.label()}</Text>
          <If when={props.showValue()}>
            <Text style={{ ...captionTextStyle, color: C.muted }}>{`${pct()}%`}</Text>
          </If>
        </View>
      </If>
      <If
        when={!terminal}
        else={<Text style={{ ...codeTextStyle, color: props.color() }}>{terminalBar()}</Text>}
      >
        <View
          style={{
            width: '100%',
            height: 8,
            borderRadius: 4,
            backgroundColor: C.cardRaised,
            overflow: 'hidden',
          }}
        >
          <View
            style={{
              width: `${pct()}%`,
              height: '100%',
              borderRadius: 4,
              backgroundColor: props.color(),
            }}
          />
        </View>
      </If>
    </View>
  );
}

function resolveBarColor(raw: unknown): string {
  switch (raw) {
    case 'success':
      return C.success;
    case 'warning':
      return C.warning;
    case 'danger':
      return C.danger;
    default:
      return C.accent;
  }
}

function renderProgress(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const max = () => {
    const m = Number(p().max ?? 100);
    return Number.isFinite(m) && m > 0 ? m : 100;
  };
  const ratio = () => (Number(p().value ?? 0) || 0) / max();
  return (
    <ProgressRow
      ratio={ratio}
      label={() => (typeof p().label === 'string' ? (p().label as string) : '')}
      showValue={() => p().showValue !== false}
      color={() => resolveBarColor(p().color)}
    />
  );
}

function renderProgressBar(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const ratio = () => {
    const prog = Number(p().progress ?? 0) || 0;
    const tot = p().total !== undefined && p().total !== null ? Number(p().total) : undefined;
    if (tot !== undefined && Number.isFinite(tot) && tot > 0) return prog / tot;
    return prog <= 1 ? prog : prog / 100;
  };
  return (
    <ProgressRow
      ratio={ratio}
      label={() => (typeof p().label === 'string' ? (p().label as string) : '')}
      showValue={() => true}
      color={() => resolveBarColor(p().color)}
    />
  );
}

function renderTabs(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const bound = useBoundField(ctx.bindings, 'value', () => undefined);
  const tabs = () => {
    const raw = Array.isArray(p().tabs) ? (p().tabs as unknown[]) : [];
    return raw
      .filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === 'object')
      .map((t) => ({
        label: String(t.label ?? t.value ?? ''),
        value: String(t.value ?? ''),
        content: typeof t.content === 'string' ? t.content : undefined,
      }));
  };
  const own = signal<string | null>(null);
  const active = () => {
    if (p().value !== undefined && p().value !== null) return String(p().value);
    if (own() !== null) return own()!;
    if (typeof p().defaultValue === 'string' && p().defaultValue) return p().defaultValue as string;
    return tabs()[0]?.value ?? '';
  };

  const inlineContent = () => tabs().find((t) => t.value === active())?.content;

  return (
    <ActiveTabCtx.Provider value={active}>
      <View style={{ width: '100%', gap: 10 }}>
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 4,
            padding: 3,
            backgroundColor: C.surface,
            borderRadius: terminal ? 0 : 10,
            borderWidth: 1,
            borderColor: C.line,
            alignSelf: 'flex-start',
          }}
        >
          <Each of={tabs()} key={(t) => t.value}>
            {(tab) => {
              const selected = () => active() === tab().value;
              return (
                <Button
                  role="tab"
                  accessibilityLabel={tab().label}
                  selected={selected()}
                  onPress={() => {
                    own.set(tab().value);
                    bound.write(tab().value);
                    ctx.emit('change');
                  }}
                  style={{
                    height: 28,
                    paddingHorizontal: 10,
                    borderRadius: terminal ? 0 : 7,
                    justifyContent: 'center',
                    backgroundColor: selected() ? C.cardRaised : 'transparent',
                  }}
                  hoverStyle={quietHoverStyle()}
                  focusStyle={quietFocusStyle()}
                >
                  <Text
                    style={{
                      ...captionTextStyle,
                      color: selected() ? C.text : C.secondary,
                      fontWeight: selected() ? '600' : undefined,
                    }}
                  >
                    {tab().label}
                  </Text>
                </Button>
              );
            }}
          </Each>
        </View>
        <If when={inlineContent()}>
          <Text style={{ ...secondaryTextStyle, color: C.text }}>{inlineContent()}</Text>
        </If>
        <Each
          of={active() !== 'default' && ctx.hasSlot(active()) ? [active()] : []}
          key={(slotName) => slotName}
        >
          {(slotName) => ctx.renderSlot(slotName())}
        </Each>
        {ctx.children()}
      </View>
    </ActiveTabCtx.Provider>
  );
}

function renderTabContent(ctx: SpecElementRenderContext): JSX.Element {
  const activeTab = ActiveTabCtx();
  const visible = () => {
    const explicit = ctx.props().activeValue;
    if (typeof explicit === 'string') {
      return explicit === String(ctx.props().value ?? '');
    }
    return !activeTab || activeTab() === String(ctx.props().value ?? '');
  };
  return <If when={visible()}>{ctx.children()}</If>;
}

function renderAccordion(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const initial = Array.isArray(p().defaultOpen)
    ? new Set((p().defaultOpen as unknown[]).map(Number).filter(Number.isInteger))
    : new Set<number>([0]);
  const openSet = signal<Set<number>>(initial);

  const items = () => {
    const raw = Array.isArray(p().items) ? (p().items as unknown[]) : [];
    return raw
      .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object')
      .map((r) => ({
        title: String(r.title ?? ''),
        content: String(r.content ?? ''),
      }));
  };

  return (
    <View
      style={{
        width: '100%',
        borderWidth: 1,
        borderColor: C.line,
        borderRadius: terminal ? 0 : 10,
        backgroundColor: C.card,
        overflow: 'hidden',
      }}
    >
      <Each of={items()} key={(item, idx) => `${idx}:${item.title}`}>
        {(item, idx) => {
          const isOpen = () => openSet().has(idx());
          return (
            <View style={{ borderTopWidth: idx() > 0 ? 1 : 0, borderTopColor: C.line }}>
              <Button
                accessibilityLabel={item().title}
                selected={isOpen()}
                onPress={() => {
                  const next = new Set(openSet());
                  if (next.has(idx())) {
                    next.delete(idx());
                  } else {
                    if (p().type !== 'multiple') next.clear();
                    next.add(idx());
                  }
                  openSet.set(next);
                }}
                style={{
                  width: '100%',
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
                hoverStyle={quietHoverStyle()}
                focusStyle={quietFocusStyle()}
              >
                <Text style={{ ...secondaryTextStyle, fontWeight: '500', color: C.text, flex: 1 }}>
                  {item().title}
                </Text>
                <Icon name={isOpen() ? 'down' : 'right'} color={C.muted} />
              </Button>
              <If when={isOpen()}>
                <View style={{ paddingHorizontal: 12, paddingBottom: 12 }}>
                  <Text style={{ ...secondaryTextStyle, color: C.secondary }}>
                    {item().content}
                  </Text>
                </View>
              </If>
            </View>
          );
        }}
      </Each>
    </View>
  );
}

function renderCollapsible(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const bound = useBoundField(ctx.bindings, 'open', () => undefined);
  const own = signal(Boolean(p().defaultOpen));
  const open = () => (typeof p().open === 'boolean' ? (p().open as boolean) : own());

  return (
    <View
      style={{
        width: '100%',
        borderWidth: 1,
        borderColor: C.line,
        borderRadius: terminal ? 0 : 10,
        backgroundColor: C.card,
      }}
    >
      <Button
        accessibilityLabel={String(p().title ?? '')}
        selected={open()}
        onPress={() => {
          const next = !open();
          own.set(next);
          bound.write(next);
          ctx.emit('change');
        }}
        style={{
          width: '100%',
          paddingHorizontal: 12,
          paddingVertical: 10,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
        hoverStyle={quietHoverStyle()}
        focusStyle={quietFocusStyle()}
      >
        <Text style={{ ...secondaryTextStyle, fontWeight: '500', color: C.text, flex: 1 }}>
          {String(p().title ?? '')}
        </Text>
        <Icon name={open() ? 'down' : 'right'} color={C.muted} />
      </Button>
      <If when={open()}>
        <View style={{ paddingHorizontal: 12, paddingBottom: 12, gap: 8 }}>{ctx.children()}</View>
      </If>
    </View>
  );
}

function renderOverlaySheet(ctx: SpecElementRenderContext, size: 'form' | 'editor'): JSX.Element {
  const runtime = useSpecRuntime();
  const p = ctx.props;
  const openPath = () => (typeof p().openPath === 'string' ? (p().openPath as string) : '');
  const isOpen = () => {
    const path = openPath();
    return path ? Boolean(runtime.get(path)) : false;
  };
  const close = () => {
    const path = openPath();
    if (path) runtime.set(path, false);
  };

  return (
    <If when={isOpen()}>
      <ModalDialog size={size} onCancel={close}>
        <DialogHeader
          title={String(p().title ?? '')}
          detail={typeof p().description === 'string' ? (p().description as string) : undefined}
        />
        <Scroll style={{ maxHeight: 420 }}>
          <View style={{ gap: 12 }}>{ctx.children()}</View>
        </Scroll>
        <DialogFooter>
          <Button
            accessibilityLabel={tr('Close')}
            onPress={close}
            style={{ ...controlStyle, borderWidth: 1, borderColor: C.line }}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
          >
            <Text style={{ ...captionTextStyle, color: C.text }}>{tr('Close')}</Text>
          </Button>
        </DialogFooter>
      </ModalDialog>
    </If>
  );
}

function renderPopover(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  return (
    <Popover
      offset={6}
      margin={8}
      popupStyle={{ ...floatingStyle(), padding: 12, maxWidth: 320 }}
      trigger={
        <Button
          accessibilityLabel={String(p().trigger ?? '')}
          style={{
            ...controlStyle,
            alignSelf: 'flex-start',
            borderWidth: 1,
            borderColor: C.line,
            backgroundColor: C.card,
          }}
          hoverStyle={controlHoverStyle()}
          focusStyle={controlFocusStyle()}
        >
          <Text style={{ ...captionTextStyle, color: C.text }}>{String(p().trigger ?? '')}</Text>
        </Button>
      }
    >
      <View style={{ gap: 8 }}>
        <If when={typeof p().content === 'string' && p().content}>
          <Text style={{ ...secondaryTextStyle, color: C.text }}>{String(p().content)}</Text>
        </If>
        {ctx.children()}
      </View>
    </Popover>
  );
}

function renderTooltip(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const tipText = () => String(p().content ?? '');
  const label = () => (typeof p().text === 'string' ? (p().text as string) : '');
  return (
    <View
      focusable
      tooltip={
        <Tooltip style={tipText().length > 48 ? richTooltipStyle() : tooltipStyle()}>
          <Text style={tooltipTextStyle()}>{tipText()}</Text>
        </Tooltip>
      }
      style={{ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 4 }}
    >
      <If when={label()}>
        <Text
          style={{
            ...secondaryTextStyle,
            color: C.text,
            textDecorationLine: 'underline',
          }}
        >
          {label()}
        </Text>
      </If>
      {ctx.children()}
    </View>
  );
}

function renderCarousel(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const idx = signal(0);
  const items = () => {
    const raw = Array.isArray(p().items) ? (p().items as unknown[]) : [];
    return raw
      .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object')
      .map((r) => ({
        title: typeof r.title === 'string' ? r.title : '',
        description: typeof r.description === 'string' ? r.description : '',
      }));
  };
  const childKeys = () => ctx.element().children ?? [];
  const count = () => (items().length > 0 ? items().length : childKeys().length);
  const current = () => Math.max(0, Math.min(Math.max(0, count() - 1), idx()));

  return (
    <View
      style={{
        width: '100%',
        padding: 12,
        gap: 10,
        backgroundColor: C.card,
        borderWidth: 1,
        borderColor: C.line,
        borderRadius: terminal ? 0 : 10,
      }}
    >
      <If when={items().length > 0} else={ctx.children()}>
        <View style={{ gap: 4 }}>
          <If when={items()[current()]?.title}>
            <Text style={{ ...secondaryTextStyle, fontWeight: '600', color: C.text }}>
              {items()[current()]?.title}
            </Text>
          </If>
          <If when={items()[current()]?.description}>
            <Text style={{ ...secondaryTextStyle, color: C.secondary }}>
              {items()[current()]?.description}
            </Text>
          </If>
        </View>
      </If>
      <If when={count() > 1}>
        <View
          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <Button
            accessibilityLabel={tr('Previous')}
            disabled={current() <= 0}
            onPress={() => idx.set(Math.max(0, current() - 1))}
            style={{
              ...controlStyle,
              minHeight: 28,
              paddingVertical: 4,
              borderWidth: 1,
              borderColor: C.line,
            }}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
            disabledStyle={controlDisabledStyle}
          >
            <Text style={{ ...captionTextStyle, color: C.text }}>{tr('Previous')}</Text>
          </Button>
          <Text style={{ ...captionTextStyle, color: C.muted }}>
            {tr('Page {page} of {total}', { page: current() + 1, total: count() })}
          </Text>
          <Button
            accessibilityLabel={tr('Next')}
            disabled={current() >= count() - 1}
            onPress={() => idx.set(Math.min(count() - 1, current() + 1))}
            style={{
              ...controlStyle,
              minHeight: 28,
              paddingVertical: 4,
              borderWidth: 1,
              borderColor: C.line,
            }}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
            disabledStyle={controlDisabledStyle}
          >
            <Text style={{ ...captionTextStyle, color: C.text }}>{tr('Next')}</Text>
          </Button>
        </View>
      </If>
    </View>
  );
}

function renderImage(ctx: SpecElementRenderContext): JSX.Element {
  const runtime = useSpecRuntime();
  const p = ctx.props;
  const src = () => (typeof p().src === 'string' ? (p().src as string) : '');
  const alt = () => String(p().alt ?? '');
  const w = () => (typeof p().width === 'number' ? (p().width as number) : undefined);
  const h = () => (typeof p().height === 'number' ? (p().height as number) : undefined);

  return (
    <If
      when={!terminal && Boolean(src()) && Boolean(runtime.sessionId)}
      else={
        <View
          style={{
            padding: 12,
            borderRadius: terminal ? 0 : 8,
            borderWidth: 1,
            borderColor: C.line,
            backgroundColor: C.card,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <Icon name="image" color={C.muted} />
          <Text style={{ ...captionTextStyle, color: C.secondary }}>{alt() || src()}</Text>
        </View>
      }
    >
      <Each of={src() && runtime.sessionId ? [src()] : []} key={(s) => s}>
        {(currentSrc) => (
          <View style={{ width: w() ?? '100%', maxWidth: '100%' }}>
            <MarkdownImageView
              image={() => ({
                src: currentSrc(),
                alt: alt(),
                width: w(),
                height: h(),
              })}
              sessionId={runtime.sessionId!}
              linked={false}
              flow="block"
              lineHeight={20}
            />
          </View>
        )}
      </Each>
    </If>
  );
}

function renderAvatar(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const initials = () => {
    const parts = String(p().name ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    return parts
      .slice(0, 2)
      .map((part) => part[0]!.toUpperCase())
      .join('');
  };
  const dim = () => (p().size === 'sm' ? 24 : p().size === 'lg' ? 40 : 32);

  return (
    <View
      accessibilityLabel={String(p().name ?? '')}
      style={{
        width: dim(),
        height: dim(),
        borderRadius: terminal ? 0 : dim() / 2,
        backgroundColor: C.cardRaised,
        borderWidth: 1,
        borderColor: C.line,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <Text style={{ ...captionTextStyle, fontWeight: '600', color: C.accent }}>
        {initials() || '?'}
      </Text>
    </View>
  );
}

function renderSkeleton(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const count = () => Math.max(1, Math.min(8, Number(p().lines ?? 2) || 2));
  const h = () => (typeof p().height === 'number' ? (p().height as number) : 14);
  return (
    <View style={{ width: '100%', gap: 8 }}>
      <Each of={Array.from({ length: count() }, (_, i) => i)} key={(i) => String(i)}>
        {(i) => (
          <View
            style={{
              width: i() === count() - 1 && count() > 1 ? '68%' : '100%',
              height: h(),
              borderRadius: terminal ? 0 : 6,
              backgroundColor: C.cardRaised,
            }}
          />
        )}
      </Each>
    </View>
  );
}

function renderSpinner(ctx: SpecElementRenderContext): JSX.Element {
  const label = () =>
    typeof ctx.props().label === 'string' && ctx.props().label
      ? (ctx.props().label as string)
      : tr('Loading…');
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Icon name="loader" color={C.accent} />
      <Text style={{ ...captionTextStyle, color: C.muted }}>{label()}</Text>
    </View>
  );
}

function renderEmptyState(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  return (
    <View
      style={{
        width: '100%',
        padding: terminal ? 12 : 20,
        gap: 8,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: C.card,
        borderWidth: 1,
        borderColor: C.line,
        borderRadius: terminal ? 0 : 10,
      }}
    >
      <Text style={{ ...secondaryTextStyle, fontWeight: '600', color: C.text }}>
        {String(p().title ?? '')}
      </Text>
      <If when={typeof p().description === 'string' && p().description}>
        <Text style={{ ...captionTextStyle, color: C.muted, textAlign: 'center' }}>
          {String(p().description)}
        </Text>
      </If>
      {ctx.children()}
    </View>
  );
}

function renderTextField(ctx: SpecElementRenderContext, multiline: boolean): JSX.Element {
  const p = ctx.props;
  const bound = useBoundField(
    ctx.bindings,
    'value',
    () => p().checks,
    () => p().validateOn,
  );
  const own = signal('');
  const val = () => (p().value !== undefined && p().value !== null ? String(p().value) : own());
  const label = () => (typeof p().label === 'string' ? (p().label as string) : '');
  const disabled = () => Boolean(p().disabled);
  const masked = () => p().type === 'password' || Boolean(p().masked);
  const rows = () => Math.max(2, Math.min(12, Number(p().rows ?? 3) || 3));
  const lineHeight = terminal ? 16 : 20;

  return (
    <View style={{ width: '100%', gap: 4 }}>
      <If when={label()}>
        <Text style={{ ...captionTextStyle, fontWeight: '500', color: C.secondary }}>
          {label()}
        </Text>
      </If>
      <View
        style={
          multiline
            ? { height: rows() * lineHeight + (terminal ? 2 : 16), minHeight: 0 }
            : undefined
        }
      >
        <Input
          accessibilityLabel={label() || String(p().placeholder ?? tr('Input'))}
          value={val()}
          placeholder={
            typeof p().placeholder === 'string' ? (p().placeholder as string) : undefined
          }
          masked={masked()}
          multiline={multiline}
          submitBehavior={multiline ? 'newline' : undefined}
          readonly={disabled()}
          autoCapitalize="none"
          autoCorrect={false}
          onChange={({ value }) => {
            own.set(value);
            bound.write(value);
            ctx.emit('change');
          }}
          onBlur={() => {
            bound.blur();
            ctx.emit('blur');
          }}
          onSubmit={() => ctx.emit('submit')}
          style={{
            ...inputTextStyle,
            color: disabled() ? C.muted : C.text,
            placeholderColor: C.muted,
            backgroundColor: C.background,
            borderWidth: 1,
            borderColor: bound.errors().length > 0 ? C.danger : C.line,
            borderRadius: inputBorderRadius,
            paddingHorizontal: terminal ? 0 : 10,
            paddingVertical: terminal ? 0 : multiline ? 8 : 4,
            ...(multiline ? { flex: 1 } : { height: terminal ? 16 : 32 }),
          }}
          focusStyle={{ borderColor: C.accent }}
        />
      </View>
      <FieldMessages
        helper={() => (typeof p().helperText === 'string' ? (p().helperText as string) : '')}
        errors={bound.errors}
      />
    </View>
  );
}

function renderNumberInput(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const bound = useBoundField(ctx.bindings, 'value', () => p().checks);
  const own = signal(0);
  const draft = signal<string | null>(null);
  const step = () => {
    const s = Number(p().step ?? 1);
    return Number.isFinite(s) && s > 0 ? s : 1;
  };
  const clampNum = (raw: number): number => {
    const lo = typeof p().min === 'number' ? (p().min as number) : Number.NEGATIVE_INFINITY;
    const hi = typeof p().max === 'number' ? (p().max as number) : Number.POSITIVE_INFINITY;
    return Math.min(hi, Math.max(lo, raw));
  };
  const current = () => {
    const v = p().value !== undefined && p().value !== null ? Number(p().value) : own();
    return Number.isFinite(v) ? v : 0;
  };
  const commit = (next: number) => {
    const clamped = clampNum(next);
    own.set(clamped);
    bound.write(clamped);
    ctx.emit('change');
  };
  const flushDraft = () => {
    const raw = draft();
    draft.set(null);
    if (raw === null) return;
    const trimmed = raw.trim();
    const parsed = Number(trimmed);
    if (trimmed !== '' && Number.isFinite(parsed)) {
      commit(parsed);
    }
  };
  const stepBy = (delta: number) => {
    const raw = draft();
    draft.set(null);
    let base = current();
    if (raw !== null) {
      const trimmed = raw.trim();
      const parsed = Number(trimmed);
      if (trimmed !== '' && Number.isFinite(parsed)) {
        base = clampNum(parsed);
      }
    }
    commit(base + delta);
  };
  const label = () => (typeof p().label === 'string' ? (p().label as string) : '');
  const disabled = () => Boolean(p().disabled);
  const decreaseLabel = () =>
    label() ? tr('Decrease {label}', { label: label() }) : tr('Decrease value');
  const increaseLabel = () =>
    label() ? tr('Increase {label}', { label: label() }) : tr('Increase value');

  return (
    <View style={{ gap: 4 }}>
      <If when={label()}>
        <Text style={{ ...captionTextStyle, fontWeight: '500', color: C.secondary }}>
          {label()}
        </Text>
      </If>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Button
          accessibilityLabel={decreaseLabel()}
          disabled={disabled()}
          onPress={() => stepBy(-step())}
          style={{
            ...controlStyle,
            width: 32,
            paddingHorizontal: 0,
            alignItems: 'center',
            borderWidth: 1,
            borderColor: C.line,
            backgroundColor: C.card,
          }}
          hoverStyle={controlHoverStyle()}
          focusStyle={controlFocusStyle()}
          disabledStyle={controlDisabledStyle}
        >
          <Icon name="minus" color={C.text} />
        </Button>
        <Input
          accessibilityLabel={label() || tr('Number')}
          value={draft() ?? String(current())}
          readonly={disabled()}
          onChange={({ value }) => {
            draft.set(value);
            const trimmed = value.trim();
            const parsed = Number(trimmed);
            if (trimmed !== '' && Number.isFinite(parsed) && clampNum(parsed) === parsed) {
              own.set(parsed);
              bound.write(parsed);
              ctx.emit('change');
            }
          }}
          onBlur={() => {
            flushDraft();
            bound.blur();
            ctx.emit('blur');
          }}
          onSubmit={() => {
            flushDraft();
            ctx.emit('submit');
          }}
          style={{
            ...inputTextStyle,
            width: 88,
            height: terminal ? 16 : 32,
            textAlign: 'center',
            color: disabled() ? C.muted : C.text,
            backgroundColor: C.background,
            borderWidth: 1,
            borderColor: bound.errors().length > 0 ? C.danger : C.line,
            borderRadius: inputBorderRadius,
            paddingHorizontal: terminal ? 0 : 8,
          }}
          focusStyle={{ borderColor: C.accent }}
        />
        <Button
          accessibilityLabel={increaseLabel()}
          disabled={disabled()}
          onPress={() => stepBy(step())}
          style={{
            ...controlStyle,
            width: 32,
            paddingHorizontal: 0,
            alignItems: 'center',
            borderWidth: 1,
            borderColor: C.line,
            backgroundColor: C.card,
          }}
          hoverStyle={controlHoverStyle()}
          focusStyle={controlFocusStyle()}
          disabledStyle={controlDisabledStyle}
        >
          <Icon name="plus" color={C.text} />
        </Button>
      </View>
      <FieldMessages errors={bound.errors} />
    </View>
  );
}

function renderSelect(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const bound = useBoundField(ctx.bindings, 'value', () => p().checks);
  const options = () => normalizeOptions(p().options);
  const own = signal<string | null>(null);
  const currentVal = () =>
    p().value !== undefined && p().value !== null && p().value !== '' ? String(p().value) : own();
  const currentOption = () => options().find((o) => o.value === currentVal());
  const label = () => (typeof p().label === 'string' ? (p().label as string) : '');
  const placeholder = () =>
    typeof p().placeholder === 'string' && p().placeholder
      ? (p().placeholder as string)
      : tr('Select…');

  return (
    <View style={{ width: '100%', gap: 4 }}>
      <If when={label()}>
        <Text style={{ ...captionTextStyle, fontWeight: '500', color: C.secondary }}>
          {label()}
        </Text>
      </If>
      <Select
        items={options().map((o) => ({
          value: o.value,
          title: o.label,
          disabled: o.disabled,
        }))}
        value={currentVal()}
        disabled={Boolean(p().disabled)}
        accessibilityLabel={label() || placeholder()}
        offset={4}
        margin={8}
        align="start"
        onChange={({ value }) => {
          if (value !== null) {
            own.set(value);
            bound.write(value);
            ctx.emit('change');
          }
        }}
        popupStyle={{
          ...floatingStyle(),
          minWidth: 200,
          maxHeight: Math.min(320, Math.max(0, windowSize().height - 16)),
        }}
        trigger={
          <View
            style={{
              minHeight: terminal ? 16 : 32,
              paddingHorizontal: terminal ? 0 : 10,
              borderRadius: inputBorderRadius,
              backgroundColor: C.background,
              borderWidth: 1,
              borderColor: bound.errors().length > 0 ? C.danger : C.line,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
            disabledStyle={controlDisabledStyle}
          >
            <Text
              style={[
                {
                  ...secondaryTextStyle,
                  color: currentOption() ? C.text : C.muted,
                  flex: 1,
                  minWidth: 0,
                },
                { numberOfLines: 1, textOverflow: 'ellipsis' },
              ]}
            >
              {currentOption()?.label ?? placeholder()}
            </Text>
            <Icon name="down" color={C.muted} size={14} />
          </View>
        }
        itemClass={`rounded-lg focus:bg-[${C.floatingRaised}]`}
        renderItem={(item) => {
          const opt = options().find((o) => o.value === item.value);
          return (
            <View style={menuRowStyle()}>
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <Text style={{ ...captionTextStyle, color: item.disabled ? C.muted : C.text }}>
                  {item.title}
                </Text>
                <If when={opt?.description}>
                  <Text style={{ ...menuDetailTextStyle, color: C.muted }}>{opt?.description}</Text>
                </If>
              </View>
              <View style={{ width: 16 }}>
                <If when={item.value === currentVal()}>
                  <Icon name="check" color={C.accent} />
                </If>
              </View>
            </View>
          );
        }}
      />
      <FieldMessages
        helper={() => (typeof p().helperText === 'string' ? (p().helperText as string) : '')}
        errors={bound.errors}
      />
    </View>
  );
}

function renderMultiSelect(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const bound = useBoundField(ctx.bindings, 'value', () => p().checks);
  const options = () => normalizeOptions(p().options);
  const own = signal<string[]>([]);
  const selected = (): string[] =>
    Array.isArray(p().value) ? (p().value as unknown[]).map(String) : own();
  const label = () => (typeof p().label === 'string' ? (p().label as string) : '');
  const disabled = () => Boolean(p().disabled);

  const toggle = (val: string) => {
    const curr = selected();
    const next = curr.includes(val) ? curr.filter((v) => v !== val) : [...curr, val];
    own.set(next);
    bound.write(next);
    ctx.emit('change');
  };

  return (
    <View style={{ width: '100%', gap: 6 }}>
      <If when={label()}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
          <Text style={{ ...captionTextStyle, fontWeight: '500', color: C.secondary }}>
            {label()}
          </Text>
          <Text style={{ ...captionTextStyle, color: C.muted }}>
            {tr('{count} selected', { count: selected().length })}
          </Text>
        </View>
      </If>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        <Each of={options()} key={(o) => o.value}>
          {(opt) => {
            const checked = () => selected().includes(opt().value);
            return (
              <Button
                accessibilityLabel={opt().label}
                selected={checked()}
                disabled={disabled() || opt().disabled}
                onPress={() => toggle(opt().value)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                  borderRadius: terminal ? 0 : 8,
                  borderWidth: 1,
                  borderColor: checked() ? C.accent : C.line,
                  backgroundColor: checked() ? C.cardRaised : C.background,
                }}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
                disabledStyle={controlDisabledStyle}
              >
                <ChoiceIndicator
                  kind="checkbox"
                  checked={checked()}
                  disabled={disabled() || opt().disabled}
                />
                <Text style={{ ...captionTextStyle, color: C.text }}>{opt().label}</Text>
              </Button>
            );
          }}
        </Each>
      </View>
      <FieldMessages errors={bound.errors} />
    </View>
  );
}

function renderCheckbox(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const bound = useBoundField(ctx.bindings, 'checked', () => p().checks);
  const own = signal(false);
  const checked = () => (typeof p().checked === 'boolean' ? (p().checked as boolean) : own());
  const disabled = () => Boolean(p().disabled);

  return (
    <View style={{ gap: 4 }}>
      <Button
        accessibilityLabel={String(p().label ?? '')}
        selected={checked()}
        disabled={disabled()}
        onPress={() => {
          const next = !checked();
          own.set(next);
          bound.write(next);
          ctx.emit('change');
        }}
        style={{
          flexDirection: 'row',
          alignItems: 'flex-start',
          justifyContent: 'flex-start',
          gap: 8,
          paddingVertical: 4,
        }}
        hoverStyle={quietHoverStyle()}
        focusStyle={quietFocusStyle()}
        disabledStyle={controlDisabledStyle}
      >
        <View style={{ paddingTop: 2 }}>
          <ChoiceIndicator kind="checkbox" checked={checked()} disabled={disabled()} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={{ ...secondaryTextStyle, color: C.text }}>{String(p().label ?? '')}</Text>
          <If when={typeof p().description === 'string' && p().description}>
            <Text style={{ ...captionTextStyle, color: C.muted }}>{String(p().description)}</Text>
          </If>
        </View>
      </Button>
      <FieldMessages errors={bound.errors} />
    </View>
  );
}

function renderRadio(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const bound = useBoundField(ctx.bindings, 'value', () => p().checks);
  const options = () => normalizeOptions(p().options);
  const own = signal<string>('');
  const current = () => (p().value !== undefined && p().value !== null ? String(p().value) : own());
  const disabled = () => Boolean(p().disabled);

  return (
    <View style={{ gap: 6 }}>
      <If when={typeof p().label === 'string' && p().label}>
        <Text style={{ ...captionTextStyle, fontWeight: '500', color: C.secondary }}>
          {String(p().label)}
        </Text>
      </If>
      <View
        style={{
          flexDirection: p().direction === 'horizontal' ? 'row' : 'column',
          flexWrap: 'wrap',
          gap: p().direction === 'horizontal' ? 12 : 6,
        }}
      >
        <Each of={options()} key={(o) => o.value}>
          {(opt) => {
            const checked = () => current() === opt().value;
            return (
              <Button
                accessibilityLabel={opt().label}
                selected={checked()}
                disabled={disabled() || opt().disabled}
                onPress={() => {
                  own.set(opt().value);
                  bound.write(opt().value);
                  ctx.emit('change');
                }}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'flex-start',
                  gap: 8,
                  paddingVertical: 4,
                }}
                hoverStyle={quietHoverStyle()}
                focusStyle={quietFocusStyle()}
                disabledStyle={controlDisabledStyle}
              >
                <ChoiceIndicator
                  kind="radio"
                  checked={checked()}
                  disabled={disabled() || opt().disabled}
                />
                <Text style={{ ...secondaryTextStyle, color: C.text }}>{opt().label}</Text>
              </Button>
            );
          }}
        </Each>
      </View>
      <FieldMessages errors={bound.errors} />
    </View>
  );
}

function renderSwitch(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const bound = useBoundField(ctx.bindings, 'checked', () => undefined);
  const own = signal(false);
  const checked = () => (typeof p().checked === 'boolean' ? (p().checked as boolean) : own());
  const disabled = () => Boolean(p().disabled);

  return (
    <Button
      accessibilityLabel={String(p().label ?? '')}
      selected={checked()}
      disabled={disabled()}
      onPress={() => {
        const next = !checked();
        own.set(next);
        bound.write(next);
        ctx.emit('change');
      }}
      style={{
        width: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        paddingVertical: 6,
      }}
      hoverStyle={quietHoverStyle()}
      focusStyle={quietFocusStyle()}
      disabledStyle={controlDisabledStyle}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={{ ...secondaryTextStyle, color: C.text }}>{String(p().label ?? '')}</Text>
        <If when={typeof p().description === 'string' && p().description}>
          <Text style={{ ...captionTextStyle, color: C.muted }}>{String(p().description)}</Text>
        </If>
      </View>
      <ChoiceIndicator kind="switch" checked={checked()} disabled={disabled()} />
    </Button>
  );
}

function renderSlider(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const bound = useBoundField(ctx.bindings, 'value', () => undefined);
  const min = () =>
    typeof p().min === 'number' && Number.isFinite(p().min) ? (p().min as number) : 0;
  const max = () =>
    typeof p().max === 'number' && Number.isFinite(p().max) ? (p().max as number) : 100;
  const step = () =>
    typeof p().step === 'number' && Number.isFinite(p().step) ? (p().step as number) : 1;
  const own = signal(min());
  const val = () =>
    typeof p().value === 'number' && Number.isFinite(p().value) ? (p().value as number) : own();
  const unit = () => (typeof p().unit === 'string' ? (p().unit as string) : '');
  const label = () => (typeof p().label === 'string' ? (p().label as string) : '');

  return (
    <View style={{ width: '100%', gap: 6 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
        <Text style={{ ...captionTextStyle, fontWeight: '500', color: C.secondary }}>
          {label()}
        </Text>
        <Text style={{ ...captionTextStyle, color: C.text, fontWeight: '600' }}>
          {`${val()}${unit()}`}
        </Text>
      </View>
      <Slider
        accessibilityLabel={label() || tr('Slider')}
        value={val()}
        min={min()}
        max={max()}
        step={step()}
        disabled={Boolean(p().disabled)}
        onChange={({ value }) => {
          const next = Array.isArray(value) ? value[0] : value;
          own.set(next);
          bound.write(next);
          ctx.emit('change');
        }}
        trackStyle={{ height: 22, justifyContent: 'center' }}
        indicatorStyle={{ height: 6, borderRadius: 3, backgroundColor: C.cardRaised }}
        rangeStyle={{ borderRadius: 3, backgroundColor: C.accent }}
        thumbStyle={{
          width: 16,
          height: 16,
          borderRadius: 8,
          backgroundColor: C.accent,
          borderWidth: 2,
          borderColor: C.background,
        }}
      />
    </View>
  );
}

function renderButton(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const variant = () => String(p().variant ?? 'primary');
  const look = () => {
    switch (variant()) {
      case 'danger':
        return { bg: C.danger, fg: C.background, border: C.danger };
      case 'secondary':
        return { bg: C.cardRaised, fg: C.text, border: C.line };
      case 'outline':
        return { bg: 'transparent', fg: C.text, border: C.line };
      case 'ghost':
        return { bg: 'transparent', fg: C.secondary, border: 'transparent' };
      default:
        return { bg: C.accent, fg: C.background, border: C.accent };
    }
  };
  const small = () => p().size === 'sm';

  return (
    <Button
      accessibilityLabel={String(p().label ?? '')}
      disabled={Boolean(p().disabled)}
      onPress={() => ctx.emit('press')}
      style={{
        ...controlStyle,
        minHeight: small() ? 28 : 32,
        paddingHorizontal: small() ? 10 : 14,
        paddingVertical: small() ? 4 : 6,
        alignSelf: 'flex-start',
        backgroundColor: look().bg,
        borderWidth: look().border === 'transparent' ? 0 : 1,
        borderColor: look().border === 'transparent' ? undefined : look().border,
      }}
      hoverStyle={
        variant() === 'primary' || variant() === 'danger' ? { opacity: 0.9 } : controlHoverStyle()
      }
      focusStyle={controlFocusStyle()}
      disabledStyle={controlDisabledStyle}
    >
      <Text
        style={{
          ...captionTextStyle,
          color: look().fg,
          fontWeight: variant() === 'primary' || variant() === 'danger' ? '600' : '500',
        }}
      >
        {String(p().label ?? '')}
      </Text>
    </Button>
  );
}

function renderButtonGroup(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const bound = useBoundField(ctx.bindings, 'selected', () => undefined);
  const buttons = () => {
    const raw = Array.isArray(p().buttons) ? (p().buttons as unknown[]) : [];
    return raw
      .filter((b): b is Record<string, unknown> => Boolean(b) && typeof b === 'object')
      .map((b) => ({
        label: String(b.label ?? ''),
        value: String(b.value ?? ''),
        disabled: Boolean(b.disabled),
      }));
  };
  const own = signal('');
  const selected = () =>
    typeof p().selected === 'string' && p().selected ? (p().selected as string) : own();

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
      <Each of={buttons()} key={(b) => b.value}>
        {(btn) => {
          const isCurrent = () => selected() === btn().value;
          return (
            <Button
              accessibilityLabel={btn().label}
              selected={isCurrent()}
              disabled={btn().disabled}
              onPress={() => {
                own.set(btn().value);
                bound.write(btn().value);
                ctx.emit('change');
              }}
              style={{
                ...controlStyle,
                minHeight: 28,
                paddingHorizontal: 10,
                paddingVertical: 4,
                backgroundColor: isCurrent() ? C.accent : C.card,
                borderWidth: 1,
                borderColor: isCurrent() ? C.accent : C.line,
              }}
              hoverStyle={isCurrent() ? { opacity: 0.9 } : controlHoverStyle()}
              focusStyle={controlFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <Text
                style={{
                  ...captionTextStyle,
                  color: isCurrent() ? C.background : C.text,
                  fontWeight: isCurrent() ? '600' : undefined,
                }}
              >
                {btn().label}
              </Text>
            </Button>
          );
        }}
      </Each>
      {ctx.children()}
    </View>
  );
}

function renderToggle(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const bound = useBoundField(ctx.bindings, 'pressed', () => undefined);
  const own = signal(false);
  const pressed = () => (typeof p().pressed === 'boolean' ? (p().pressed as boolean) : own());

  return (
    <Button
      accessibilityLabel={String(p().label ?? '')}
      selected={pressed()}
      disabled={Boolean(p().disabled)}
      onPress={() => {
        const next = !pressed();
        own.set(next);
        bound.write(next);
        ctx.emit('change');
      }}
      style={{
        ...controlStyle,
        minHeight: 28,
        paddingHorizontal: 10,
        paddingVertical: 4,
        alignSelf: 'flex-start',
        backgroundColor: pressed() ? C.cardRaised : 'transparent',
        borderWidth: 1,
        borderColor: pressed() ? C.accent : C.line,
      }}
      hoverStyle={controlHoverStyle()}
      focusStyle={controlFocusStyle()}
      disabledStyle={controlDisabledStyle}
    >
      <Text
        style={{
          ...captionTextStyle,
          color: pressed() ? C.accent : C.secondary,
          fontWeight: pressed() ? '600' : undefined,
        }}
      >
        {String(p().label ?? '')}
      </Text>
    </Button>
  );
}

function renderToggleGroup(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const bound = useBoundField(ctx.bindings, 'value', () => undefined);
  const multiple = () => p().type === 'multiple';
  const items = () => normalizeOptions(p().items);
  const ownSingle = signal('');
  const ownMulti = signal<string[]>([]);

  const isSelected = (val: string): boolean => {
    if (multiple()) {
      const arr = Array.isArray(p().value) ? (p().value as unknown[]).map(String) : ownMulti();
      return arr.includes(val);
    }
    const curr = typeof p().value === 'string' ? (p().value as string) : ownSingle();
    return curr === val;
  };

  const toggle = (val: string) => {
    if (multiple()) {
      const curr = Array.isArray(p().value) ? (p().value as unknown[]).map(String) : ownMulti();
      const next = curr.includes(val) ? curr.filter((v) => v !== val) : [...curr, val];
      ownMulti.set(next);
      bound.write(next);
    } else {
      ownSingle.set(val);
      bound.write(val);
    }
    ctx.emit('change');
  };

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
      <Each of={items()} key={(it) => it.value}>
        {(it) => {
          const active = () => isSelected(it().value);
          return (
            <Button
              accessibilityLabel={it().label}
              selected={active()}
              onPress={() => toggle(it().value)}
              style={{
                ...controlStyle,
                minHeight: 28,
                paddingHorizontal: 10,
                paddingVertical: 4,
                backgroundColor: active() ? C.cardRaised : C.background,
                borderWidth: 1,
                borderColor: active() ? C.accent : C.line,
              }}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
            >
              <Text
                style={{
                  ...captionTextStyle,
                  color: active() ? C.accent : C.secondary,
                  fontWeight: active() ? '600' : undefined,
                }}
              >
                {it().label}
              </Text>
            </Button>
          );
        }}
      </Each>
    </View>
  );
}

function renderDropdownMenu(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const bound = useBoundField(ctx.bindings, 'value', () => undefined);
  const open = signal(false);
  const items = () => normalizeOptions(p().items);

  return (
    <Popover
      open={open()}
      onOpenChange={({ open: next }) => open.set(next)}
      offset={4}
      margin={8}
      align="start"
      popupStyle={{ ...floatingStyle(), minWidth: 180 }}
      trigger={
        <Button
          accessibilityLabel={String(p().label ?? '')}
          style={{
            ...controlStyle,
            alignSelf: 'flex-start',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            borderWidth: 1,
            borderColor: C.line,
            backgroundColor: C.card,
          }}
          hoverStyle={controlHoverStyle()}
          focusStyle={controlFocusStyle()}
        >
          <Text style={{ ...captionTextStyle, color: C.text }}>{String(p().label ?? '')}</Text>
          <Icon name="down" color={C.muted} size={14} />
        </Button>
      }
    >
      <View style={{ gap: 2 }}>
        <Each of={items()} key={(it) => it.value}>
          {(it) => (
            <Button
              accessibilityLabel={it().label}
              disabled={it().disabled}
              onPress={() => {
                bound.write(it().value);
                open.set(false);
                ctx.emit('select');
              }}
              style={menuRowStyle()}
              hoverStyle={{ backgroundColor: C.floatingRaised }}
              focusStyle={{ backgroundColor: C.floatingRaised }}
              disabledStyle={controlDisabledStyle}
            >
              <Text style={{ ...captionTextStyle, color: it().disabled ? C.muted : C.text }}>
                {it().label}
              </Text>
            </Button>
          )}
        </Each>
      </View>
    </Popover>
  );
}

function renderPagination(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const bound = useBoundField(ctx.bindings, 'page', () => undefined);
  const own = signal(1);
  const total = () => Math.max(1, Math.round(Number(p().totalPages ?? 1) || 1));
  const current = () => {
    const raw = typeof p().page === 'number' ? Math.round(p().page as number) : own();
    return Math.max(1, Math.min(total(), raw || 1));
  };
  const go = (next: number) => {
    const clamped = Math.max(1, Math.min(total(), next));
    own.set(clamped);
    bound.write(clamped);
    ctx.emit('change');
  };

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Button
        accessibilityLabel={tr('Previous')}
        disabled={current() <= 1}
        onPress={() => go(current() - 1)}
        style={{
          ...controlStyle,
          minHeight: 28,
          paddingVertical: 4,
          borderWidth: 1,
          borderColor: C.line,
          backgroundColor: C.card,
        }}
        hoverStyle={controlHoverStyle()}
        focusStyle={controlFocusStyle()}
        disabledStyle={controlDisabledStyle}
      >
        <Text style={{ ...captionTextStyle, color: C.text }}>{tr('Previous')}</Text>
      </Button>
      <Text style={{ ...captionTextStyle, color: C.secondary }}>
        {tr('Page {page} of {total}', { page: current(), total: total() })}
      </Text>
      <Button
        accessibilityLabel={tr('Next')}
        disabled={current() >= total()}
        onPress={() => go(current() + 1)}
        style={{
          ...controlStyle,
          minHeight: 28,
          paddingVertical: 4,
          borderWidth: 1,
          borderColor: C.line,
          backgroundColor: C.card,
        }}
        hoverStyle={controlHoverStyle()}
        focusStyle={controlFocusStyle()}
        disabledStyle={controlDisabledStyle}
      >
        <Text style={{ ...captionTextStyle, color: C.text }}>{tr('Next')}</Text>
      </Button>
    </View>
  );
}

function renderConfirmInput(ctx: SpecElementRenderContext): JSX.Element {
  const p = ctx.props;
  const bound = useBoundField(ctx.bindings, 'value', () => undefined);
  const confirmLabel = () =>
    typeof p().confirmLabel === 'string' && p().confirmLabel
      ? (p().confirmLabel as string)
      : tr('Confirm');
  const cancelLabel = () =>
    typeof p().cancelLabel === 'string' && p().cancelLabel
      ? (p().cancelLabel as string)
      : tr('Cancel');

  return (
    <View
      style={{
        width: '100%',
        padding: 12,
        gap: 10,
        backgroundColor: C.card,
        borderWidth: 1,
        borderColor: C.line,
        borderRadius: terminal ? 0 : 10,
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <Text style={{ ...secondaryTextStyle, color: C.text, flex: 1 }}>
        {String(p().message ?? '')}
      </Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button
          accessibilityLabel={cancelLabel()}
          onPress={() => {
            bound.write(false);
            ctx.emit('cancel');
          }}
          style={{
            ...controlStyle,
            minHeight: 28,
            paddingVertical: 4,
            borderWidth: 1,
            borderColor: C.line,
          }}
          hoverStyle={controlHoverStyle()}
          focusStyle={controlFocusStyle()}
        >
          <Text style={{ ...captionTextStyle, color: C.text }}>{cancelLabel()}</Text>
        </Button>
        <Button
          accessibilityLabel={confirmLabel()}
          onPress={() => {
            bound.write(true);
            ctx.emit('confirm');
          }}
          style={{ ...controlStyle, minHeight: 28, paddingVertical: 4, backgroundColor: C.accent }}
          hoverStyle={{ opacity: 0.9 }}
          focusStyle={controlFocusStyle()}
        >
          <Text style={{ ...captionTextStyle, color: C.background, fontWeight: '600' }}>
            {confirmLabel()}
          </Text>
        </Button>
      </View>
    </View>
  );
}

function renderLink(ctx: SpecElementRenderContext): JSX.Element {
  const runtime = useSpecRuntime();
  const p = ctx.props;
  const href = () => String(p().href ?? '');
  const label = () => String(p().label ?? href());
  let buttonRef: ViewRef | undefined;
  let alive = true;
  cleanup(() => {
    alive = false;
  });

  return (
    <Button
      ref={(node) => {
        buttonRef = node;
      }}
      accessibilityLabel={label()}
      onPress={() => {
        ctx.emit('press');
        if (alive && href() && runtime.openLink) {
          void runtime.openLink(href(), () => {
            if (!alive || !buttonRef) return false;
            buttonRef.focus();
            return true;
          });
        }
      }}
      style={{ alignSelf: 'flex-start', paddingVertical: 2 }}
      hoverStyle={quietHoverStyle()}
      focusStyle={quietFocusStyle()}
    >
      <Text
        style={{
          ...secondaryTextStyle,
          color: C.accent,
          textDecorationLine: 'underline',
        }}
      >
        {label()}
      </Text>
    </Button>
  );
}

export const specComponentRegistry: SpecComponentRegistry = {
  Card: renderCard,
  Text: renderText,
  Stack: renderStack,
  Grid: renderGrid,
  Box: renderBox,
  Spacer: renderSpacer,
  Newline: renderNewline,
  Separator: renderSeparator,
  Divider: renderDivider,
  Heading: renderHeading,
  Markdown: renderMarkdown,
  CodeBlock: renderCodeBlock,
  Badge: renderBadge,
  StatusLine: renderStatusLine,
  Alert: renderAlert,
  Callout: renderCallout,
  Metric: renderMetric,
  KeyValue: renderKeyValue,
  Table: renderTable,
  List: renderList,
  ListItem: renderListItem,
  Timeline: renderTimeline,
  Progress: renderProgress,
  ProgressBar: renderProgressBar,
  LineChart: renderLineChart,
  AreaChart: renderAreaChart,
  BarChart: renderBarChart,
  PieChart: renderPieChart,
  ScatterChart: renderScatterChart,
  Heatmap: renderHeatmap,
  Sparkline: renderSparkline,
  Tabs: renderTabs,
  TabContent: renderTabContent,
  Accordion: renderAccordion,
  Collapsible: renderCollapsible,
  Dialog: (ctx) => renderOverlaySheet(ctx, 'form'),
  Drawer: (ctx) => renderOverlaySheet(ctx, 'editor'),
  Popover: renderPopover,
  Tooltip: renderTooltip,
  Carousel: renderCarousel,
  Image: renderImage,
  Avatar: renderAvatar,
  Skeleton: renderSkeleton,
  Spinner: renderSpinner,
  EmptyState: renderEmptyState,
  Input: (ctx) => renderTextField(ctx, false),
  TextInput: (ctx) => renderTextField(ctx, false),
  Textarea: (ctx) => renderTextField(ctx, true),
  NumberInput: renderNumberInput,
  Select: renderSelect,
  MultiSelect: renderMultiSelect,
  Checkbox: renderCheckbox,
  Radio: renderRadio,
  Switch: renderSwitch,
  Slider: renderSlider,
  Button: renderButton,
  ButtonGroup: renderButtonGroup,
  Toggle: renderToggle,
  ToggleGroup: renderToggleGroup,
  DropdownMenu: renderDropdownMenu,
  Pagination: renderPagination,
  ConfirmInput: renderConfirmInput,
  Link: renderLink,
};
