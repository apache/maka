import { type JSX, signal, Text, View, type YNode } from "nsh";
import { announce, reduceMotion, screenReaderEnabled, setAccessibilityFocus } from "nsh";
import { LayoutAnimation } from "nsh";
import { locale, pixelRatio, platform } from "nsh";
import { InputAccessoryView } from "nsh/mobile";
import { Dialog, Input, type InputProps, NavPage, Sheet } from "nsh/base";
import { safeArea } from "nsh";
import { Icon, type IconName } from "../icons";
import { nav } from "../nav";
import { TitleBar } from "../TitleBar";
import { Appear, Badge, Button, Caption, Card, colors, DemoPage, finish, header, hint, IconTile, Inset, isDark, mono, PageHeader, Press, radius, Row, Segmented, tints, Toggle, type Tone, toneColor, toneTint } from "../ui";

// One device pixel, in points (reading it in a binding follows the screen).
const hairline = () => 1 / pixelRatio();

/** A dark input, 48 pt tall. */
function Field(props: InputProps) {
  const focused = signal(false);
  return (
    <Input
      onFocus={() => focused.set(true)}
      onBlur={() => focused.set(false)}
      {...props}
      style={{
        placeholderColor: colors.faint,
        selectionColor: colors.accent,
        height: 48,
        paddingHorizontal: 14,
        fontSize: 15,
        color: colors.text,
        backgroundColor: colors.field,
        borderWidth: 1,
        borderColor: focused() ? colors.accent : colors.fieldBorder,
        borderRadius: radius.control,
        ...finish.field,
      }}
    />
  );
}

/** A cell of a row of equal widths. */
function Cell(props: { children: JSX.Element }) {
  return <View style={{ flex: 1 }}>{props.children}</View>;
}

/** A row that pushes a screen. */
function LinkRow(props: { icon: IconName; title: string; note: string; onPress: () => void }) {
  return (
    <Press onPress={props.onPress} scale={0.98} accessibilityLabel={props.title}>
      <View style={{ minHeight: 60, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 10, paddingVertical: 8 }}>
        <IconTile name={props.icon} size={34} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ fontSize: 15, fontWeight: "500", color: colors.text }}>{props.title}</Text>
          <Text numberOfLines={1} style={{ fontSize: 12, color: colors.faint, fontFamily: mono }}>
            {props.note}
          </Text>
        </View>
        <Icon name="chevron" size={14} tint={colors.faint} />
      </View>
    </Press>
  );
}

const presets = [
  { value: "spring", label: "Spring" },
  { value: "easeInEaseOut", label: "Ease" },
  { value: "linear", label: "Linear" },
] as const;

const tileTones: Tone[] = ["accent", "info", "warn", "up", "danger"];

function LayoutAnimations() {
  const items = signal([1, 2, 3]);
  const preset = signal<(typeof presets)[number]["value"]>("spring");
  let next = 4;
  const animate = (change: () => void) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets[preset()]);
    change();
  };
  return (
    <Card icon="animation" title="Layout animation" subtitle="configureNext, then change the tree" right={<Badge label={`${items().length}`} />}>
      <Segmented options={presets} value={preset()} onChange={(p) => preset.set(p)} size="small" />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, minHeight: 56 }}>
        <Each of={items()}>
          {(n) => (
            <View
              style={{
                width: 56,
                height: 56,
                borderRadius: 14,
                borderCurve: "continuous",
                backgroundColor: toneTint(tileTones[n() % tileTones.length]),
                boxShadow: isDark() ? "inset 0 1px 0 rgba(255,255,255,0.06)" : "inset 0 1px 0 #ffffff",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text style={{ fontSize: 17, fontWeight: "600", fontVariant: ["tabular-nums"], color: toneColor(tileTones[n() % tileTones.length]) }}>{n()}</Text>
            </View>
          )}
        </Each>
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Cell><Button label="Add" icon="plus" onPress={() => animate(() => items.set([next++, ...items()]))} /></Cell>
        <Cell><Button label="Shuffle" variant="secondary" onPress={() => animate(() => items.set([...items()].sort(() => Math.random() - 0.5)))} /></Cell>
        <Cell><Button label="Remove" variant="secondary" disabled={items().length === 0} onPress={() => animate(() => items.set(items().slice(1)))} /></Cell>
      </View>
    </Card>
  );
}

function PressableSheet() {
  const sheet = signal(false);
  return (
    <Card icon="components" title="Sheet" subtitle="A Tailwind active: variant opens it">
      <View
        onPress={() => sheet.set(true)}
        role="button"
        style={{ boxShadow: finish.accent.boxShadow }}
        class="h-12 flex-row items-center justify-center gap-2 rounded-[12px] bg-[#c8f26d] transition active:scale-[0.97] active:bg-[#a9d14f]"
      >
        <Text style={{ fontSize: 15, fontWeight: "600", color: colors.onAccent }}>Open a sheet</Text>
      </View>
      <Caption label="Scales and darkens while pressed" note="active:scale-[0.97]" />
      <Sheet
        open={sheet()}
        onOpenChange={(open) => sheet.set(open)}
        backdropStyle={{ backgroundColor: "rgba(0,0,0,0.5)" }}
        popupStyle={{
          gap: 16,
          padding: 20,
          paddingBottom: safeArea().bottom + 20,
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          backgroundColor: colors.background,
        }}
      >
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: "row" }}>
            <Badge label="Sheet" tone="accent" />
          </View>
          <Text style={{ fontSize: 28, fontWeight: "700", letterSpacing: -0.5, color: colors.text }}>A sheet</Text>
          <Text style={{ fontSize: 15, lineHeight: 21, color: colors.muted }}>
            {hint("Tap outside it or press back (Android) to close.", "Press Escape or click outside it to close.")}
          </Text>
        </View>
        <Button label="Close" onPress={() => sheet.set(false)} />
      </Sheet>
    </Card>
  );
}

/** A tile to press, with the prop it shows. */
function Tile(props: { title: string; note: string; children?: JSX.Element }) {
  return (
    <View style={{ minHeight: 60, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 8 }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontSize: 15, color: colors.text }}>{props.title}</Text>
        <Text style={{ fontSize: 12, color: colors.faint, fontFamily: mono }}>{props.note}</Text>
      </View>
      {props.children}
    </View>
  );
}

const tile = () =>
  ({
    borderRadius: radius.control,
    borderCurve: "continuous",
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    // The raised highlight without its gradient, so an underlay color shows.
    boxShadow: finish.raised.boxShadow,
  }) as const;

/** Press feedback is native: opacity, an underlay, classes; `disabled` takes no presses. */
function PressFeedback() {
  const last = signal("None yet");
  const disabled = signal(false);
  return (
    <Card icon="gestures" title="Press feedback" subtitle={hint("Drawn natively while the finger is down", "Drawn natively while the button is down")}>
      <View style={tile()} activeStyle={{ opacity: 0.4 }} onPress={() => last.set("Fading tile")}>
        <Tile title="Fades while pressed" note="activeStyle={{ opacity: 0.4 }}" />
      </View>
      <View style={tile()} activeStyle={{ backgroundColor: colors.raised }} onPress={() => last.set("Underlay tile")}>
        <Tile title="Lights up while pressed" note="activeStyle={{ backgroundColor }}" />
      </View>
      <View style={tile()} disabled={disabled()} activeStyle={{ backgroundColor: tints.danger }} class="disabled:opacity-40" onPress={() => last.set("Enabled tile")}>
        <Tile title={disabled() ? "Takes no presses" : "Enabled"} note="disabled + disabled:opacity-40">
          <Badge label={disabled() ? "Off" : "On"} tone={disabled() ? "neutral" : "up"} />
        </Tile>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Caption label="Last pressed" note={last()} />
        </View>
        <Toggle value={disabled()} onChange={(v) => disabled.set(v)} label="Disable the third tile" />
      </View>
    </Card>
  );
}

function Accessory() {
  const text = signal("");
  let input: YNode | undefined;
  return (
    <Card icon="text" title="Input accessory" subtitle="A bar over the iOS keyboard" right={<Badge label="nsh/mobile" />}>
      <Field
        ref={(node) => (input = node)}
        value={text()}
        onChange={(v) => text.set(v)}
        placeholder="Focus me"
        ios={{ inputAccessoryViewID: "counter" }}
      />
      <Caption
        label={platform.idiom === "desktop" ? "Desktops have no input accessories" : platform.os === "android" ? "Android has no input accessories" : "The bar counts what you type"} note='inputAccessoryViewID="counter"' />
      <InputAccessoryView nativeID="counter" style={{ backgroundColor: colors.surface }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingHorizontal: 16,
            paddingVertical: 8,
            borderTopWidth: hairline(),
            borderTopColor: colors.border,
          }}
        >
          <Text style={{ flex: 1, fontSize: 13, color: colors.muted, fontVariant: ["tabular-nums"] }}>{`${text().length} characters`}</Text>
          <Button label="Clear" variant="secondary" onPress={() => text.set("")} />
          <Button label="Done" onPress={() => input?.blur()} />
        </View>
      </InputAccessoryView>
    </Card>
  );
}

const behaviors = [
  { value: "padding", label: "padding" },
  { value: "height", label: "height" },
] as const;

const behaviorNote = {
  padding: "padding-bottom: env(keyboard-inset-height). The tinted background stays under the keyboard.",
  height: "margin-bottom: env(keyboard-inset-height). The view shrinks: its background ends at the keyboard.",
} as const;

function AvoidingPage() {
  const behavior = signal<"padding" | "height">("padding");
  return (
    <NavPage title="Keyboard inset" {...header} header={<PageHeader title="Keyboard inset" />}>
      <View
        style={{
          flex: 1,
          backgroundColor: tints.info,
          ...(behavior() === "padding"
            ? { paddingBottom: "env(keyboard-inset-height)" }
            : { marginBottom: "env(keyboard-inset-height)" }),
        }}
      >
        <View style={{ flex: 1, padding: 16, gap: 16 }}>
          <Appear>
            <Card icon="form" title={`behavior="${behavior()}"`} subtitle="Focus the field at the bottom">
              <Segmented options={behaviors} value={behavior()} onChange={(b) => behavior.set(b)} />
              <Text style={{ fontSize: 14, lineHeight: 20, color: colors.muted }}>{behaviorNote[behavior()]}</Text>
            </Card>
          </Appear>
          <View style={{ flex: 1 }} />
          <Field placeholder="Type here" />
        </View>
      </View>
    </NavPage>
  );
}

function ModalOptions() {
  const visible = signal(false);
  const translucent = signal(false);
  return (
    <Card
      icon="system"
      title="Dialog options"
      subtitle="statusBarTranslucent, orientations"
      right={<Toggle value={translucent()} onChange={(v) => translucent.set(v)} label="statusBarTranslucent" />}
    >
      <Text style={{ fontSize: 14, lineHeight: 20, color: colors.muted }}>
        Android: translucent content reaches under the status bar. iOS: this dialog allows portrait and landscape.
      </Text>
      <Caption label="statusBarTranslucent" note={String(translucent())} />
      <Button label="Open the dialog" variant="secondary" onPress={() => visible.set(true)} />
      <Dialog
        open={visible()}
        animation="slide"
        android={{ statusBarTranslucent: translucent() }}
        ios={{ supportedOrientations: ["portrait", "landscape"] }}
        onOpenChange={(open) => visible.set(open)}
        style={{ flex: 1 }}
      >
        <View style={{ flex: 1, backgroundColor: isDark() ? "#16200d" : "#eef5dc" }}>
          <TitleBar />
          <View
            style={{
              flex: 1,
              padding: 16,
              paddingTop: "calc(env(safe-area-inset-top) + 16px)",
              paddingRight: "calc(env(safe-area-inset-right) + 16px)",
              paddingBottom: "calc(env(safe-area-inset-bottom) + 16px)",
              paddingLeft: "calc(env(safe-area-inset-left) + 16px)",
              gap: 12,
            }}
          >
            <View style={{ flexDirection: "row", paddingTop: 8 }}>
              <Badge label={translucent() ? "translucent" : "opaque bar"} tone="accent" />
            </View>
            <Text style={{ fontSize: 28, fontWeight: "700", letterSpacing: -0.5, color: colors.text }}>A dialog</Text>
            <Text style={{ fontSize: 15, lineHeight: 21, color: colors.muted }}>
              The olive background starts {translucent() ? "under" : "below"} the status bar on Android.
            </Text>
            <View style={{ flex: 1 }} />
            <Button label="Close" onPress={() => visible.set(false)} />
          </View>
        </View>
      </Dialog>
    </Card>
  );
}

function PlatformInfo() {
  const rows = (): [string, string][] => [
    ["platform.os", platform.os],
    ["platform.version", platform.version],
    ["platform.idiom / catalyst", `${platform.idiom} / ${platform.catalyst}`],
    ["platform.select", platform.select({ ios: "ios branch", android: "android branch" }) ?? ""],
    ["pixelRatio()", String(pixelRatio())],
    ["10.3 on whole pixels", String(Math.round(10.3 * pixelRatio()) / pixelRatio())],
    ["screenReaderEnabled()", String(screenReaderEnabled())],
    ["reduceMotion()", String(reduceMotion())],
    ["locale()", locale()],
  ];
  const announced = signal(0);
  let target: YNode | undefined;
  return (
    <Card icon="spark" title="Platform" subtitle="platform, pixelRatio, announce" right={<Badge label={platform.os} tone="accent" />}>
      <View>
        <Each of={rows()}>
          {(row, i) => (
            <Row first={i() === 0}>
              <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, color: colors.muted, fontFamily: mono }}>
                {row()[0]}
              </Text>
              <Text numberOfLines={1} style={{ fontSize: 14, color: colors.text, fontVariant: ["tabular-nums"] }}>
                {row()[1]}
              </Text>
            </Row>
          )}
        </Each>
      </View>
      <View style={{ height: hairline(), backgroundColor: colors.accent }} />
      <Caption label="The line above is one device pixel tall" note={`${hairline().toFixed(3)} pt`} />
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Cell><Button
          label="Announce"
          onPress={() => {
            announced.set(announced() + 1);
            announce(`Announcement ${announced()}`);
          }}
        /></Cell>
        <Cell><Button label="Focus the note" variant="secondary" onPress={() => target && setAccessibilityFocus(target)} /></Cell>
      </View>
      <Text ref={(node) => (target = node)} style={{ fontSize: 13, lineHeight: 18, color: colors.faint }}>
        With VoiceOver or TalkBack on, the buttons above speak and move the reader here.
      </Text>
    </Card>
  );
}

export function Components() {
  return (
    <DemoPage
      keyboardDismissMode="interactive"
      cards={[
        PressFeedback,
        PressableSheet,
        LayoutAnimations,
        Accessory,
        () => (
          <Card title="Keyboard avoidance" subtitle="Content outside scroll views" flush>
            <Inset padding={0} gap={0}>
              <LinkRow icon="form" title="Keyboard inset" note="env(keyboard-inset-height)" onPress={() => nav.push({ name: "page", page: AvoidingPage })} />
            </Inset>
          </Card>
        ),
        ModalOptions,
        PlatformInfo,
      ]}
    />
  );
}
