import { Image, type JSX, Text, View } from "nsh";
import { Icon } from "../../icons";
import { alpha, Badge, colors, finish, isDark, mono, Press, radius, type Tone, toneColor, toneTint } from "../../ui";
import { Glyph, type GlyphName } from "./glyphs";
import type { FileRef, Source, Tool, ToolState } from "./scripts";

/** A ring that spins natively (the built-in `spin` keyframes). */
export function Spinner(props: { size?: number; tint?: string }) {
  const size = props.size ?? 14;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: 2,
        borderColor: colors.border,
        borderTopColor: props.tint ?? colors.accent,
        animationName: "spin",
        animationDuration: 800,
        animationTimingFunction: "linear",
        animationIterationCount: "infinite",
      }}
    />
  );
}

/** The streaming caret: an inline block that pulses natively. */
export function Caret() {
  return (
    <View
      style={{
        width: 8,
        height: 16,
        marginLeft: 2,
        borderRadius: 2,
        backgroundColor: colors.accent,
        animationName: "pulse",
        animationDuration: 900,
        animationIterationCount: "infinite",
      }}
    />
  );
}

/** A small icon button under a reply (44 pt touch target). */
export function ActionButton(props: { glyph: GlyphName; label: string; active?: boolean; tone?: Tone; onPress: () => void }) {
  return (
    <Press onPress={props.onPress} scale={0.86} accessibilityLabel={props.label} accessibilityState={{ selected: props.active }}>
      <View style={{ width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", margin: 4 }}>
        <View
          style={{
            position: "absolute",
            width: 32,
            height: 32,
            borderRadius: 16,
            backgroundColor: props.active ? toneTint(props.tone ?? "accent") : "transparent",
            transitionProperty: "colors",
            transitionDuration: 180,
          }}
        />
        <Glyph name={props.glyph} size={17} tint={props.active ? toneColor(props.tone ?? "accent") : colors.muted} />
      </View>
    </Press>
  );
}

/** A row between days. */
export function DateSeparator(props: { label: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
      <Text style={{ fontSize: 12, fontWeight: "500", color: colors.faint }}>{props.label}</Text>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
    </View>
  );
}

/** A file as a chip: an icon, the name and the size. */
export function FileChip(props: { file: FileRef; onRemove?: () => void }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        height: 48,
        paddingLeft: 10,
        paddingRight: props.onRemove ? 4 : 14,
        borderRadius: radius.control,
        borderCurve: "continuous",
        backgroundColor: colors.raised,
        ...finish.raised,
        borderWidth: 1,
        borderColor: colors.border,
      }}
    >
      <View style={{ width: 30, height: 30, borderRadius: 8, backgroundColor: tintFor("danger"), alignItems: "center", justifyContent: "center" }}>
        <Glyph name="file" size={16} tint={colors.danger} />
      </View>
      <View style={{ gap: 1 }}>
        <Text numberOfLines={1} style={{ fontSize: 14, color: colors.text, maxWidth: 170 }}>
          {props.file.name}
        </Text>
        <Text style={{ fontSize: 12, color: colors.muted, fontVariant: ["tabular-nums"] }}>{(props.file.name.split(".").pop() ?? "file").toUpperCase()} · {props.file.size}</Text>
      </View>
      <If when={props.onRemove}>
        <Press onPress={props.onRemove} accessibilityLabel="Remove file" scale={0.85}>
          <View style={{ width: 40, height: 44, alignItems: "center", justifyContent: "center" }}>
            <Glyph name="close" size={14} tint={colors.muted} />
          </View>
        </Press>
      </If>
    </View>
  );
}

const tintFor = (tone: Tone) => toneTint(tone);

/** An attached image, rounded. */
export function Photo(props: { src: string; width: number; height: number; children?: JSX.Element }) {
  return (
    <View style={{ width: props.width, height: props.height, borderRadius: radius.inset, borderCurve: "continuous", overflow: "hidden", backgroundColor: colors.raised, borderWidth: 1, borderColor: colors.border }}>
      <Image src={props.src} style={{ width: props.width, height: props.height }} />
      {props.children}
    </View>
  );
}

const stateLabel: Record<ToolState, string> = { pending: "Queued", running: "Running", done: "Done", cancelled: "Stopped" };
const stateTone: Record<ToolState, Tone> = { pending: "neutral", running: "info", done: "up", cancelled: "warn" };

/** A tool call: a header with its state, then its result once done. */
export function ToolCard(props: { tool: Tool }) {
  const t = () => props.tool;
  const head = (): { glyph: GlyphName; title: string; detail: string } => {
    const tool = t();
    if (tool.kind === "search") return { glyph: "globe", title: "Web search", detail: tool.query };
    if (tool.kind === "weather") return { glyph: "sun", title: "Weather", detail: tool.city };
    return { glyph: "terminal", title: "Run code", detail: `${tool.lang}, sandboxed` };
  };
  return (
    <View
      style={{
        backgroundColor: colors.surface,
        ...finish.card,
        borderRadius: radius.inset,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: t().state === "running" ? (isDark() ? "#33405a" : alpha(colors.info, 0.4)) : colors.border,
        transitionProperty: "colors",
        transitionDuration: 250,
        overflow: "hidden",
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 12 }}>
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: 9,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: colors.raised,
            ...finish.raised,
            borderWidth: 1,
            borderColor: colors.border,
          }}
        >
          <Glyph name={head().glyph} size={16} tint={colors.text} />
        </View>
        <View style={{ flex: 1, gap: 1 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>{head().title}</Text>
          <Text numberOfLines={1} style={{ fontSize: 13, color: colors.muted }}>
            {head().detail}
          </Text>
        </View>
        <If when={t().state === "running" || t().state === "pending"} else={<Badge label={stateLabel[t().state]} tone={stateTone[t().state]} />}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Spinner tint={t().state === "pending" ? colors.faint : colors.info} />
            <Text style={{ fontSize: 13, color: colors.muted }}>{stateLabel[t().state]}</Text>
          </View>
        </If>
      </View>
      <ToolBody tool={t()} />
    </View>
  );
}

function ToolBody(props: { tool: Tool }) {
  // The kind never changes for a card; its state and data do.
  const kind = props.tool.kind;
  const search = () => props.tool as Extract<Tool, { kind: "search" }>;
  const weather = () => props.tool as Extract<Tool, { kind: "weather" }>;
  const code = () => props.tool as Extract<Tool, { kind: "code" }>;
  if (kind === "search")
    return (
      <If when={search().state === "done"}>
        <View style={{ borderTopWidth: 1, borderTopColor: colors.line, paddingVertical: 4 }}>
          <Each of={search().sources}>{(source, i) => <SourceRow source={source()} index={i()} />}</Each>
        </View>
      </If>
    );
  if (kind === "weather")
    return (
      <If when={weather().state === "done"}>
        <View style={{ borderTopWidth: 1, borderTopColor: colors.line, padding: 12, gap: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 12 }}>
            <Text style={{ fontSize: 40, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"], letterSpacing: -1 }}>{weather().temp}°</Text>
            <View style={{ flex: 1, paddingBottom: 7, gap: 2 }}>
              <Text style={{ fontSize: 15, color: colors.text }}>{weather().condition}</Text>
              <Text style={{ fontSize: 13, color: colors.muted, fontVariant: ["tabular-nums"] }}>
                H {weather().high}°  L {weather().low}°
              </Text>
            </View>
          </View>
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 6, height: 44 }}>
            <Each of={weather().hours}>
              {(temp, i) => (
                <View style={{ flex: 1, alignItems: "center", gap: 4 }}>
                  <View
                    style={{
                      width: "100%",
                      height: 6 + (temp() - weather().low) * 3,
                      borderRadius: 3,
                      backgroundColor: i() === 0 ? colors.warn : colors.raised,
                    }}
                  />
                  <Text style={{ fontSize: 11, color: colors.faint, fontVariant: ["tabular-nums"] }}>{(17 + i()) % 24}h</Text>
                </View>
              )}
            </Each>
          </View>
        </View>
      </If>
    );
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.line }}>
      <View style={{ padding: 12, backgroundColor: colors.inset }}>
        <Text selectable style={{ fontFamily: mono, fontSize: 12, lineHeight: 18, color: isDark() ? "#c9cdd3" : colors.code }}>{code().code}</Text>
      </View>
      <If when={code().state === "done"}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, height: 44, borderTopWidth: 1, borderTopColor: colors.line }}>
          <Text style={{ fontSize: 13, color: colors.muted }}>Output</Text>
          <Text selectable style={{ flex: 1, fontFamily: mono, fontSize: 14, color: colors.up }}>{code().output}</Text>
          <Text style={{ fontSize: 12, color: colors.faint, fontVariant: ["tabular-nums"] }}>exit 0 · {code().ms} ms</Text>
        </View>
      </If>
    </View>
  );
}

function SourceRow(props: { source: Source; index: number }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, height: 48, paddingHorizontal: 12 }}>
      <View style={{ width: 24, height: 24, borderRadius: 6, backgroundColor: toneTint(props.source.tone), alignItems: "center", justifyContent: "center" }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: toneColor(props.source.tone) }}>{props.source.site[0].toUpperCase()}</Text>
      </View>
      <View style={{ flex: 1, gap: 1 }}>
        <Text numberOfLines={1} style={{ fontSize: 14, color: colors.text }}>
          {props.source.title}
        </Text>
        <Text style={{ fontSize: 12, color: colors.faint }}>{props.source.site}</Text>
      </View>
      <Text style={{ fontSize: 12, color: colors.faint, fontVariant: ["tabular-nums"] }}>{props.index + 1}</Text>
    </View>
  );
}

/** The reply's error: what went wrong and a Retry button. */
export function ErrorRow(props: { message: string; onRetry: () => void }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        padding: 12,
        borderRadius: radius.inset,
        borderCurve: "continuous",
        backgroundColor: toneTint("danger"),
        borderWidth: 1,
        borderColor: alpha(colors.danger, 0.32),
      }}
    >
      <Glyph name="alert" size={18} tint={colors.danger} />
      <Text style={{ flex: 1, fontSize: 14, lineHeight: 19, color: colors.text }}>{props.message}</Text>
      <Press onPress={props.onRetry} accessibilityLabel="Retry">
        <View
          style={{
            height: 36,
            paddingHorizontal: 14,
            borderRadius: 18,
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            backgroundColor: colors.light,
            ...finish.light,
          }}
        >
          <Glyph name="regenerate" size={14} tint={colors.onLight} />
          <Text style={{ fontSize: 13, fontWeight: "600", color: colors.onLight }}>Retry</Text>
        </View>
      </Press>
    </View>
  );
}

/** The assistant's avatar: a small tile with the spark. */
export function Avatar() {
  return (
    <View
      style={{
        width: 26,
        height: 26,
        borderRadius: 8,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors.raised,
        ...finish.raised,
        borderWidth: 1,
        borderColor: colors.border,
      }}
    >
      <Icon name="spark" size={14} tint={colors.accent} />
    </View>
  );
}
