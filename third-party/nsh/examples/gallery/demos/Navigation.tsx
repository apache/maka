import { effect, type JSX, Scroll, signal, Text, View } from "nsh";
import { createAnimatedValue } from "nsh";
import { BackHandler } from "nsh/mobile";
import { platform } from "nsh";
import { AlertDialog, Dialog, NavPage, Input } from "nsh/base";
import { safeAreaInsets } from "nsh";
import { Icon, type IconName } from "../icons";
import { nav } from "../nav";
import { Appear, Badge, Button, Card, colors, DemoPage, Figure, finish, header, hint, IconTile, Inset, isDark, mono, motion, PageHeader, Press, radius, Section, Stat, tints, Toggle } from "../ui";
import { TitleBar } from "../TitleBar";

const edges = ["top", "bottom", "left", "right"] as const;

/** The safe-area insets where it renders, one figure per edge. */
function Insets() {
  const insets = safeAreaInsets();
  return (
    <View style={{ flexDirection: "row" }}>
      <Each of={edges}>{(edge) => <Stat width="25%" label={edge()[0].toUpperCase() + edge().slice(1)} value={`${Math.round(insets()[edge()])} pt`} />}</Each>
    </View>
  );
}

/** A row that pushes a screen: an icon, a title, the API it shows. */
function LinkRow(props: { icon: IconName; title: string; note: string; first?: boolean; onPress: () => void }) {
  return (
    <Press onPress={props.onPress} scale={0.98} accessibilityLabel={props.title}>
      <View
        style={{
          minHeight: 60,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          paddingHorizontal: 10,
          paddingVertical: 8,
          borderTopWidth: props.first ? 0 : 1,
          borderTopColor: colors.line,
        }}
      >
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

/** The body of a pushed screen: what it shows, then where its safe area is. */
function Page(props: { intro: string; children?: JSX.Element }) {
  return (
    <Scroll style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ padding: 16, paddingBottom: 40, gap: 16 }}>
        <Appear>
          <Text style={{ fontSize: 15, lineHeight: 21, color: colors.muted, paddingHorizontal: 4 }}>{props.intro}</Text>
        </Appear>
        <Appear index={1}>
          <Section title="Safe area" note="safeAreaInsets()">
            <Insets />
          </Section>
        </Appear>
        <Appear index={2}>
          <View style={{ gap: 16 }}>{props.children}</View>
        </Appear>
      </View>
    </Scroll>
  );
}

function LargeTitle() {
  return (
    <NavPage title="Large title" {...header} headerLargeTitle header={<PageHeader title="Large title" />}>
      <Page intro="iOS: the title shrinks into the bar as the content scrolls.">
        <Card flush>
          <Inset padding={0} gap={0}>
            <Each of={Array.from({ length: 20 }, (_, i) => i + 1)}>
              {(i) => (
                <View
                  style={{
                    height: 48,
                    flexDirection: "row",
                    alignItems: "center",
                    paddingHorizontal: 10,
                    borderTopWidth: i() === 1 ? 0 : 1,
                    borderTopColor: colors.line,
                  }}
                >
                  <Text style={{ flex: 1, fontSize: 15, color: colors.text }}>Row {i()}</Text>
                  <Text style={{ fontSize: 13, color: colors.faint, fontVariant: ["tabular-nums"] }}>{`${i() * 48} pt`}</Text>
                </View>
              )}
            </Each>
          </Inset>
        </Card>
      </Page>
    </NavPage>
  );
}

function Transparent() {
  return (
    <NavPage
      title="Transparent"
      headerTransparent
      headerStyle={{ tintColor: colors.text, color: colors.text }}
      header={<PageHeader title="Transparent" transparent tint={colors.text} />}
    >
      <View style={{ flex: 1, backgroundColor: isDark() ? "#11170c" : "#eef3e2", overflow: "hidden", padding: 16, paddingBottom: 56, justifyContent: "flex-end", gap: 16 }}>
        <View style={{ position: "absolute", top: -90, right: -70, width: 320, height: 320, borderRadius: 160, backgroundColor: tints.accent }} />
        <View style={{ position: "absolute", top: 150, left: -110, width: 260, height: 260, borderRadius: 130, backgroundColor: tints.info }} />
        <Appear>
          <View style={{ gap: 12 }}>
            <View style={{ flexDirection: "row" }}>
              <Badge label="headerTransparent" tone="accent" />
            </View>
            <Text style={{ fontSize: 30, fontWeight: "700", letterSpacing: -0.5, color: colors.text }}>Content under the header</Text>
            <Text style={{ fontSize: 15, lineHeight: 21, color: colors.muted }}>
              The circles start at the top of the screen; the bar and its back button float over them.
            </Text>
          </View>
        </Appear>
        <Appear index={1}>
          <Inset>
            <Insets />
          </Inset>
        </Appear>
      </View>
    </NavPage>
  );
}

function CustomHeader() {
  const likes = signal(0);
  // Each call makes the elements anew: the system header (phones) and the
  // app's (desktops, the web) each mount their own.
  const left = () => (
    <Text onPress={() => nav.pop()} hitSlop={10} style={{ color: colors.onAccent, fontSize: 17, fontWeight: "500" }}>
      Close
    </Text>
  );
  const center = () => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: colors.onAccent }} />
      <Text style={{ color: colors.onAccent, fontSize: 17, fontWeight: "700" }}>Custom title</Text>
    </View>
  );
  const right = () => (
    <View onPress={() => likes.set(likes() + 1)} hitSlop={10} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
      <Icon name="star" size={18} tint={colors.onAccent} />
      <Text style={{ color: colors.onAccent, fontSize: 17, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{likes()}</Text>
    </View>
  );
  return (
    <NavPage
      title="Custom"
      headerStyle={{ tintColor: colors.onAccent, backgroundColor: colors.accentFill, color: colors.onAccent }}
      headerBackVisible={false}
      headerLeft={left()}
      headerTitle={center()}
      headerRight={right()}
      header={<PageHeader title="Custom" background={colors.accentFill} left={left()} center={center()} right={right()} />}
    >
      <Page intro="The header's items are views: the star on the right counts presses and re-renders the header.">
        <Section title="Header" note="headerRight">
          <Figure value={String(likes())} unit={likes() === 1 ? "star" : "stars"} />
        </Section>
      </Page>
    </NavPage>
  );
}

function Locked() {
  return (
    <NavPage title="No swipe back" {...header} popOnSwipe={false} header={<PageHeader title="No swipe back" />}>
      <Page
        intro={hint(
          "The back gesture is off on this screen: no swipe on iOS, no predictive animation on Android. The back buttons still work.",
          "The back gesture is off on this screen (touch screens only). The back button, Escape and Alt+Left still work.",
        )}
      >
        <Section title="Leaving" note="popOnSwipe={false}">
          <View style={{ flexDirection: "row" }}>
            <Stat width="50%" label="Swipe / predictive" value="Off" tone="danger" />
            <Stat width="50%" label="Back buttons" value="On" tone="up" />
          </View>
        </Section>
      </Page>
    </NavPage>
  );
}

/** `popOnBack={false}`: leaving with unsaved text asks first. */
function Unsaved() {
  const text = signal("");
  const focused = signal(false);
  const confirm = async () => {
    const action = await AlertDialog.show({
      title: "Discard your changes?",
      actions: [
        { label: "Keep editing", role: "cancel" },
        { label: "Discard", role: "destructive", id: "discard" },
      ],
    });
    if (action === "discard") nav.pop();
  };
  return (
    <NavPage
      title="Unsaved changes"
      {...header}
      popOnBack={text().length === 0}
      onBackPress={confirm}
      header={<PageHeader title="Unsaved changes" onBack={() => (text().length > 0 ? confirm() : nav.pop())} />}
    >
      <Page
        intro={hint(
          "Type something, then go back (header button, swipe, Android back): the screen asks first.",
          "Type something, then go back (header button, Escape, Alt+Left, the mouse's back button): the screen asks first.",
        )}
      >
        <Card icon="form" title="Draft" subtitle="popOnBack + onBackPress" right={<Badge label={text().length > 0 ? "Guarded" : "Empty"} tone={text().length > 0 ? "warn" : "neutral"} />}>
          <Input
            value={text()}
            onChange={(v) => text.set(v)}
            onFocus={() => focused.set(true)}
            onBlur={() => focused.set(false)}
            placeholder="A draft"
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
          <Text style={{ fontSize: 13, color: colors.muted }}>
            {text().length > 0 ? `${text().length} characters would be lost: back asks first` : "Nothing to lose: back pops"}
          </Text>
        </Card>
      </Page>
    </NavPage>
  );
}

function Faded() {
  return (
    <NavPage title="Fade" {...header} animation="fade" header={<PageHeader title="Fade" />}>
      <Page intro="This screen faded in, and fades out." />
    </NavPage>
  );
}

function Instant() {
  return (
    <NavPage title="No animation" {...header} animation="none" header={<PageHeader title="No animation" />}>
      <Page intro="Shown without a transition, and removed without one." />
    </NavPage>
  );
}

/** Padding by the insets of the root the view renders in, on every edge. */
const safeAreaPadding = {
  paddingTop: "env(safe-area-inset-top)",
  paddingRight: "env(safe-area-inset-right)",
  paddingBottom: "env(safe-area-inset-bottom)",
  paddingLeft: "env(safe-area-inset-left)",
} as const;

function Headerless() {
  return (
    <NavPage headerVisible={false}>
      <View style={{ flex: 1, backgroundColor: colors.background, ...safeAreaPadding }}>
        <View style={{ flex: 1, padding: 16, gap: 16 }}>
          <Appear>
            <View style={{ gap: 8, paddingHorizontal: 4, paddingTop: 12 }}>
              <View style={{ flexDirection: "row" }}>
                <Badge label="headerVisible={false}" tone="accent" />
              </View>
              <Text style={{ fontSize: 30, fontWeight: "700", letterSpacing: -0.5, color: colors.text }}>No header</Text>
              <Text style={{ fontSize: 15, lineHeight: 21, color: colors.muted }}>
                The screen owns the whole surface; padding of env(safe-area-inset-*) keeps it clear of the status bar and the home indicator.
              </Text>
            </View>
          </Appear>
          <Appear index={1}>
            <Section title="Safe area" note="env(safe-area-inset-*)">
              <Insets />
            </Section>
          </Appear>
          <View style={{ flex: 1 }} />
          <Button label="Back" onPress={() => nav.pop()} />
        </View>
      </View>
    </NavPage>
  );
}

function Deep(props: { depth: number }) {
  return (
    <NavPage title={`Level ${props.depth}`} {...header} header={<PageHeader title={`Level ${props.depth}`} />}>
      <Page intro="Every push is a native screen; popToRoot() unwinds them all at once.">
        <Card icon="nav" title={`Level ${props.depth}`} subtitle={`${props.depth} deep in the stack`}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            <Each of={Array.from({ length: props.depth }, (_, i) => i + 1)}>
              {(level) => (
                <View
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    alignItems: "center",
                    justifyContent: "center",
                    borderWidth: level() === props.depth ? 0 : 1,
                    borderColor: colors.border,
                    backgroundColor: level() === props.depth ? colors.accentFill : colors.raised,
                    ...(level() === props.depth ? finish.accent : finish.raised),
                  }}
                >
                  <Text style={{ fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"], color: level() === props.depth ? colors.onAccent : colors.muted }}>{level()}</Text>
                </View>
              )}
            </Each>
          </View>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button flex={1} label="Deeper" icon="plus" onPress={() => nav.push({ name: "page", page: () => <Deep depth={props.depth + 1} /> })} />
            <Button flex={1} label="To the index" variant="secondary" onPress={() => nav.popToRoot()} />
          </View>
        </Card>
      </Page>
    </NavPage>
  );
}

type Sheet = "fullScreen" | "pageSheet" | "formSheet" | "fade" | "dialog" | "kept" | null;

const modals: { key: Exclude<Sheet, null>; title: string; note: string; icon: IconName }[] = [
  { key: "fullScreen", title: "Full screen", note: "Slides up", icon: "mobile" },
  { key: "pageSheet", title: "Page sheet", note: hint("iOS sheet", "A tall centered card"), icon: "components" },
  { key: "formSheet", title: "Form sheet", note: hint("iOS, centered", "A smaller centered card"), icon: "form" },
  { key: "fade", title: "Fade", note: "Fades in", icon: "spark" },
  { key: "dialog", title: "Dialog", note: "See-through", icon: "bell" },
  { key: "kept", title: "Kept open", note: hint("No swipe to close", "Escape does not close"), icon: "arrow-down" },
];

/** A modal's content: what it is, its safe area, a close button. */
function ModalBody(props: { title: string; note: string; body: string; fullScreen?: boolean; onClose: () => void }) {
  return (
    <View style={{ flex: 1, backgroundColor: colors.background, ...safeAreaPadding }}>
      <If when={props.fullScreen}><TitleBar /></If>
      <View style={{ flex: 1, padding: 16, gap: 16 }}>
        <View style={{ gap: 8, paddingHorizontal: 4, paddingTop: 8 }}>
          <View style={{ flexDirection: "row" }}>
            <Badge label={props.note} tone="accent" />
          </View>
          <Text style={{ fontSize: 28, fontWeight: "700", letterSpacing: -0.5, color: colors.text }}>{props.title}</Text>
          <Text style={{ fontSize: 15, lineHeight: 21, color: colors.muted }}>{props.body}</Text>
        </View>
        <Section title="Safe area" note="the modal's">
          <Insets />
        </Section>
        <View style={{ flex: 1 }} />
        <Button label="Close" onPress={props.onClose} />
      </View>
    </View>
  );
}

export function Navigation() {
  const sheet = signal<Sheet>(null);
  const intercept = signal(false);
  const backs = signal(0);
  const cancels = signal(0);
  const close = () => sheet.set(null);
  // A listener hears the button before the stack pops it; listening only
  // while intercepting keeps Android's back gesture previewing the pop.
  effect(() => {
    if (!intercept()) return;
    // Removed with the effect when it runs again.
    BackHandler.onBackPress(() => {
      backs.set(backs() + 1);
      return true;
    });
  });
  const push = (page: () => JSX.Element) => () => nav.push({ name: "page", page });
  // The dialog springs up from a little smaller each time it opens.
  const pop = createAnimatedValue(0);
  effect(() => {
    if (sheet() !== "dialog") return;
    pop.set(0);
    pop.spring(1, motion.settle);
  });
  const current = () => modals.find((m) => m.key === sheet());

  return (
    <DemoPage
      cards={[
        () => (
          <Card icon="nav" title="Native stack" subtitle="Headers, transitions, the safe area" right={<Badge label={hint("UIKit / View", platform.os === "linux" ? "GTK 4" : "Native views")} />}>
            <Insets />
          </Card>
        ),
        () => (
          <Card title="Pages" subtitle="Page options, pushed with nav.push" flush>
            <Inset padding={0} gap={0}>
              <LinkRow first icon="text" title="Large title" note="headerLargeTitle" onPress={push(LargeTitle)} />
              <LinkRow icon="styles" title="Transparent header" note="headerTransparent" onPress={push(Transparent)} />
              <LinkRow icon="star" title="Custom header items" note="headerLeft / Title / Right" onPress={push(CustomHeader)} />
              <LinkRow icon="mobile" title="No header" note="headerVisible={false}" onPress={push(Headerless)} />
              <LinkRow icon="spark" title="Fade in" note='animation="fade"' onPress={push(Faded)} />
              <LinkRow icon="play" title="No animation" note='animation="none"' onPress={push(Instant)} />
              <LinkRow icon="gestures" title="No swipe back" note="popOnSwipe={false}" onPress={push(Locked)} />
              <LinkRow icon="form" title="Unsaved changes" note="popOnBack + onBackPress" onPress={push(Unsaved)} />
              <LinkRow icon="lists" title="A deep stack" note="push / popToRoot" onPress={push(() => <Deep depth={1} />)} />
            </Inset>
          </Card>
        ),
        () => (
          <Card title="Modals" subtitle="Presentation styles and transitions" flush>
            <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: 8 }}>
              <Each of={modals}>
                {(m) => (
                  <Press onPress={() => sheet.set(m().key)} accessibilityLabel={m().title} style={{ width: "48.5%" }}>
                    <View
                      style={{
                        minHeight: 100,
                        padding: 12,
                        gap: 12,
                        borderRadius: radius.inset,
                        borderCurve: "continuous",
                        backgroundColor: colors.inset,
                        borderWidth: 1,
                        borderColor: colors.line,
                        ...finish.inset,
                      }}
                    >
                      <IconTile name={m().icon} size={32} />
                      <View style={{ gap: 2 }}>
                        <Text style={{ fontSize: 15, fontWeight: "500", color: colors.text }}>{m().title}</Text>
                        <Text style={{ fontSize: 13, color: colors.faint }}>{m().note}</Text>
                      </View>
                    </View>
                  </Press>
                )}
              </Each>
            </View>
          </Card>
        ),
        () => (
          <Card
            icon="system"
            title="Back button"
            subtitle={hint("Android: BackHandler", "BackHandler: Escape, Alt+Left")}
            right={<Toggle value={intercept()} onChange={(v) => intercept.set(v)} label="Intercept the back button" />}
          >
            <Figure value={String(backs())} unit={backs() === 1 ? "press" : "presses"} note={intercept() ? "caught" : "popped"} tone={intercept() ? "warn" : "accent"} />
            <Text style={{ fontSize: 13, lineHeight: 18, color: colors.muted }}>
              {intercept()
                ? "The handler returns true: back presses stay on this screen."
                : hint("Off: the back button pops this screen.", "Off: Escape pops this screen, or the app's last screen does nothing.")}
            </Text>
          </Card>
        ),
      ]}
    >
      <Dialog
        open={sheet() === "fullScreen" || sheet() === "pageSheet" || sheet() === "formSheet" || sheet() === "fade"}
        presentation={sheet() === "pageSheet" ? "pageSheet" : sheet() === "formSheet" ? "formSheet" : "fullScreen"}
        animation={sheet() === "fade" ? "fade" : "slide"}
        onOpenChange={(open) => !open && close()}
        style={{ flex: 1 }}
      >
        <ModalBody
          fullScreen={sheet() === "fullScreen" || sheet() === "fade"}
          title={current()?.title ?? ""}
          note={String(sheet())}
          body={hint(
            "Close with the button, the back button (Android) or a swipe down (iOS sheets): it closes natively, then tells the app (onOpenChange).",
            sheet() === "pageSheet" || sheet() === "formSheet" ? "Close with the button, Escape or a click outside the card." : "Close with the button or Escape.",
          )}
          onClose={close}
        />
      </Dialog>
      <Dialog
        open={sheet() === "kept"}
        presentation="pageSheet"
        closeOnEscape={false}
        closeOnBackdropPress={false}
        closeOnSwipe={false}
        onCancel={() => cancels.set(cancels() + 1)}
        style={{ flex: 1 }}
      >
        <ModalBody
          title="Kept open"
          note="closeOn*={false}"
          body={`${hint("Swiping it down (iOS) and back (Android)", "Escape and clicks outside")} only call onCancel (${cancels()} so far): the button closes it.`}
          onClose={close}
        />
      </Dialog>
      <Dialog open={sheet() === "dialog"} animation="fade" onOpenChange={(open) => !open && close()} style={{ flex: 1 }}>
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.62)", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <View
            style={{
              alignSelf: "stretch",
              opacity: pop,
              transform: [{ scale: pop.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) }],
            }}
          >
            <Card icon="bell" title="A dialog" subtitle='animation="fade"'>
              <Text style={{ fontSize: 15, lineHeight: 21, color: colors.muted }}>
                A dialog owns no look: what is behind it shows through, and the card springs in natively.
              </Text>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Button flex={1} label="Cancel" variant="secondary" onPress={close} />
                <Button flex={1} label="OK" onPress={close} />
              </View>
            </Card>
          </View>
        </View>
      </Dialog>
    </DemoPage>
  );
}
