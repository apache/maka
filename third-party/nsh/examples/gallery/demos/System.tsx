import { cleanup, resource, signal, Text, View } from "nsh";
import { createAnimatedValue, Easing } from "nsh";
import { colorScheme, fontScale, windowSize } from "nsh";
import { AlertDialog, type AlertDialogAction, Dialog, type StatusBarForeground } from "nsh/base";
import { keyboardFrame, safeArea } from "nsh";
import { Menu } from "nsh/desktop";
import { keymap } from "nsh";
import { Icon, type IconName } from "../icons";
import { toast } from "../toast";
import { Appear, Badge, Button, Caption, Card, colors, DemoPage, Figure, finish, IconTile, isDark, Inset, Legend, Meter, mono, Press, Row, Segmented, Stat, tints, Toggle, type Tone, toneColor } from "../ui";

/** The window drawn to scale, with the safe area insets shaded. */
function SafeAreaDiagram() {
  const width = 76;
  const scale = () => width / Math.max(1, windowSize().width);
  const height = () => Math.round(windowSize().height * scale());
  const band = (pt: number) => Math.max(0, Math.round(pt * scale()));
  return (
    <View
      style={{
        width,
        height: height(),
        borderRadius: 14,
        borderCurve: "continuous",
        borderWidth: 1.5,
        borderColor: colors.border,
        backgroundColor: colors.surface,
        backgroundImage: finish.card.backgroundImage,
        boxShadow: isDark() ? "inset 0 1px 0 rgba(255,255,255,0.06)" : "inset 0 1px 0 #ffffff",
        overflow: "hidden",
      }}
    >
      <View style={{ height: band(safeArea().top), backgroundColor: tints.info }} />
      <View style={{ flex: 1, margin: 6, borderRadius: 6, borderWidth: 1, borderColor: colors.line, borderStyle: "dashed" }} />
      <View style={{ height: band(keyboardFrame().height), backgroundColor: tints.warn }} />
      <View style={{ height: band(safeArea().bottom), backgroundColor: tints.info }} />
    </View>
  );
}

function Environment() {
  const insets = () => [
    { label: "Top", value: safeArea().top },
    { label: "Right", value: safeArea().right },
    { label: "Bottom", value: safeArea().bottom },
    { label: "Left", value: safeArea().left },
  ];
  return (
    <Card icon="system" title="Environment" subtitle="Updates when the window, insets or keyboard change" right={<Badge label="Live" tone="up" />}>
      <View style={{ flexDirection: "row", gap: 16, alignItems: "center" }}>
        <View style={{ flex: 1, gap: 12 }}>
          <View style={{ gap: 2 }}>
            <Text style={{ fontSize: 12, color: colors.muted }}>Window</Text>
            <Figure value={`${Math.round(windowSize().width)} × ${Math.round(windowSize().height)}`} unit="pt" />
          </View>
          <View style={{ flexDirection: "row" }}>
            <Stat label="Keyboard" value={`${Math.round(keyboardFrame().height)} pt`} tone={keyboardFrame().height > 0 ? "warn" : undefined} width="50%" />
            <Stat label="Font scale" value={`${fontScale().toFixed(2)}×`} width="50%" />
          </View>
        </View>
        <SafeAreaDiagram />
      </View>
      <View style={{ height: 1, backgroundColor: colors.line }} />
      <View style={{ gap: 4 }}>
        <Caption label="Safe area insets" note="pt" />
        <View style={{ flexDirection: "row" }}>
          <Each of={insets()}>{(inset) => <Stat label={inset().label} value={String(Math.round(inset().value))} width="25%" />}</Each>
        </View>
      </View>
      <View style={{ height: 1, backgroundColor: colors.line }} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
        <Legend color={colors.info} label="Safe area" />
        <Legend color={colors.warn} label="Keyboard" />
        <View style={{ flex: 1 }} />
        <Badge label={colorScheme() === "dark" ? "Dark scheme" : "Light scheme"} tone={colorScheme() === "dark" ? "info" : "warn"} outline />
      </View>
    </Card>
  );
}

function StatusBarCard() {
  // Until one is picked, the content follows the appearance (light content on the dark page).
  const picked = signal<StatusBarForeground | null>(null);
  const foreground = () => picked() ?? (isDark() ? "light" : "dark");
  const barHidden = signal(false);
  const open = signal(false);
  // The preview's background: the one its content is for.
  const backdrop = () => (foreground() === "light" ? "#101113" : foreground() === "dark" ? "#f4f4f2" : colors.background);
  return (
    <Card icon="mobile" title="Status bar" subtitle="A dialog's statusBar: over the page's while it is open">
      <Segmented
        options={[
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
          { value: "auto", label: "Auto" },
        ]}
        value={foreground()}
        onChange={(v) => picked.set(v)}
      />
      <Row>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ fontSize: 15, color: colors.text }}>Hidden</Text>
          <Text style={{ fontSize: 12, color: colors.muted, fontFamily: mono }}>{`foreground: "${foreground()}"`}</Text>
        </View>
        <Toggle value={barHidden()} onChange={(v) => barHidden.set(v)} label="Hide the status bar" />
      </Row>
      <Button label="Preview" icon="mobile" onPress={() => open.set(true)} />
      <Dialog
        open={open()}
        animation="fade"
        statusBar={{ foreground: foreground(), hidden: barHidden(), animated: true }}
        onOpenChange={({ open: o }) => open.set(o)}
        style={{ flex: 1 }}
      >
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 16, backgroundColor: backdrop() }}>
          <Text style={{ fontSize: 13, color: foreground() === "light" ? "#ffffff" : "#111214", fontFamily: mono }}>
            {`statusBar: { foreground: "${foreground()}", hidden: ${barHidden()} }`}
          </Text>
          <Button label="Close" onPress={() => open.set(false)} />
        </View>
      </Dialog>
    </Card>
  );
}

/** A tappable row with an icon tile, a title, a detail and a chevron. */
function ActionRow(props: { first?: boolean; icon: IconName; tint: string; title: string; detail: string; onPress: () => void }) {
  return (
    <Press onPress={props.onPress} scale={0.98} accessibilityLabel={props.title}>
      <Row first={props.first}>
        <IconTile name={props.icon} tint={props.tint} size={34} />
        <View style={{ flex: 1, gap: 1, paddingVertical: 8 }}>
          <Text style={{ fontSize: 15, color: colors.text }}>{props.title}</Text>
          <Text style={{ fontSize: 12, color: colors.muted }}>{props.detail}</Text>
        </View>
        <Icon name="chevron" size={14} tint={colors.faint} />
      </Row>
    </Press>
  );
}

/** What the gallery shows for the action `AlertDialog.show` reported: its label (none: dismissed). */
function labelOf(actions: AlertDialogAction[], id?: string | null): string {
  return actions.find((a) => a.id === id)?.label ?? "dismissed";
}

function Dialogs() {
  const answer = signal<{ text: string; tone: Tone } | null>(null);
  // The answer pops in each time it changes.
  const pop = createAnimatedValue(1);
  const show = (text: string, tone: Tone = "neutral") => {
    answer.set({ text, tone });
    pop.set(0.85);
    pop.spring(1, { stiffness: 380, damping: 18 });
  };
  return (
    <Card icon="bell" title="Alerts and sheets" subtitle="AlertDialog · Toast" flush>
      <Inset gap={0} padding={12}>
        <ActionRow
          first
          icon="check"
          tint={colors.up}
          title="Alert"
          detail="One button"
          onPress={async () => {
            await AlertDialog.show({ title: "Saved", description: "Your changes were saved.", actions: [{ label: "OK", id: "ok" }] });
            show("OK", "up");
          }}
        />
        <ActionRow
          icon="bell"
          tint={colors.danger}
          title="Confirm"
          detail="Cancel and destructive buttons"
          onPress={async () => {
            const actions: AlertDialogAction[] = [
              { label: "Cancel", role: "cancel", id: "cancel" },
              { label: "Delete", role: "destructive", id: "delete" },
            ];
            const { action } = await AlertDialog.show({
              title: "Delete the photo?",
              description: "This cannot be undone.",
              actions,
              closeOnEscape: true,
              closeOnBackdropPress: true,
            });
            show(labelOf(actions, action), action === "delete" ? "danger" : "neutral");
          }}
        />
        <ActionRow
          icon="star"
          tint={colors.info}
          title="Three buttons"
          detail="Shows the label of the action pressed"
          onPress={async () => {
            const actions: AlertDialogAction[] = [
              { label: "Later", id: "later" },
              { label: "Never", role: "cancel", id: "never" },
              { label: "Install", id: "install" },
            ];
            const { action } = await AlertDialog.show({ title: "Update available", description: "Install it now?", actions });
            show(labelOf(actions, action), action === "install" ? "info" : "neutral");
          }}
        />
        <ActionRow
          icon="lists"
          tint={colors.accent}
          title="Action sheet"
          detail="Title, cancel and destructive options"
          onPress={async () => {
            const actions: AlertDialogAction[] = [
              { label: "Cancel", role: "cancel", id: "cancel" },
              { label: "Copy link", id: "copy" },
              { label: "Save", id: "save" },
              { label: "Delete", role: "destructive", id: "delete" },
            ];
            const { action } = await AlertDialog.show({ title: "Share the photo", presentation: "actionSheet", actions });
            show(labelOf(actions, action), action === "delete" ? "danger" : "accent");
          }}
        />
        <ActionRow icon="spark" tint={colors.warn} title="Toast" detail="nsh/base, every platform" onPress={() => void toast({ title: "Hello from a toast", description: "nsh/base's ToastManager, styled by the gallery" })} />
      </Inset>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 11, paddingTop: 12, paddingBottom: 11, minHeight: 44 }}>
        <Text style={{ flex: 1, fontSize: 13, color: colors.muted }}>Answer</Text>
        <If when={answer()} else={<Text style={{ fontSize: 13, color: colors.faint }}>None yet</Text>}>
          <View style={{ scale: pop }}>
            <Badge label={answer()!.text} tone={answer()!.tone} />
          </View>
        </If>
      </View>
    </Card>
  );
}

function FramesAndTimers() {
  const fps = signal(0);
  const running = signal(false);
  const ticks = signal(0);
  // The beat dot flashes once per tick; the fade runs natively.
  const beat = createAnimatedValue(0);

  // Frames per second, counted with requestAnimationFrame.
  let frame = 0;
  let frames = 0;
  let since = 0;
  const loop = (time: number) => {
    frames++;
    if (time - since >= 1000) {
      fps.set(Math.round((frames * 1000) / (time - since)));
      frames = 0;
      since = time;
    }
    frame = requestAnimationFrame(loop);
  };
  const toggle = () => {
    if (running()) cancelAnimationFrame(frame);
    else {
      frames = 0;
      since = performance.now();
      frame = requestAnimationFrame(loop);
    }
    running.set(!running());
  };
  const timer = setInterval(() => {
    ticks.set(ticks() + 1);
    beat.set(1);
    beat.timing(0, { duration: 700, easing: Easing.out(Easing.quad) });
  }, 1000);
  cleanup(() => {
    clearInterval(timer);
    cancelAnimationFrame(frame);
  });

  return (
    <Card icon="animation" title="Frames and timers" subtitle="requestAnimationFrame · setInterval">
      <View style={{ flexDirection: "row", gap: 12 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ fontSize: 12, color: colors.muted }}>Frame rate</Text>
          <Figure value={running() ? String(fps()) : "–"} unit="fps" note={running() ? "live" : "stopped"} tone={running() ? "up" : "neutral"} />
        </View>
        <View style={{ width: 1, backgroundColor: colors.line }} />
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={{ fontSize: 12, color: colors.muted }}>Interval ticks</Text>
            <View
              style={{
                width: 7,
                height: 7,
                borderRadius: 3.5,
                backgroundColor: colors.accent,
                opacity: beat.interpolate({ inputRange: [0, 1], outputRange: [0.25, 1] }),
                scale: beat.interpolate({ inputRange: [0, 1], outputRange: [1, 1.6] }),
              }}
            />
          </View>
          <Figure value={String(ticks())} note="every 1 s" tone="accent" />
        </View>
      </View>
      <View style={{ gap: 8 }}>
        <Caption label="Share of 120 fps" note={running() ? `${Math.round((fps() / 120) * 100)}%` : "–"} />
        <Meter value={running() ? fps() / 120 : 0} tone="up" marker={0.5} />
      </View>
      <Button label={running() ? "Stop counting frames" : "Count frames"} icon={running() ? "pause" : "play"} onPress={toggle} />
    </Card>
  );
}

/** App-level shortcuts: bound while the demo shows (the component's own). */
function Shortcuts() {
  const count = signal(0);
  const on = signal(false);
  const last = signal("");
  keymap.bind({
    "mod+k": ({ keystroke }) => {
      count.set(count() + 1);
      last.set(keystroke);
    },
    "mod+shift+l": ({ keystroke }) => {
      on.set(!on());
      last.set(keystroke);
    },
  });
  keymap.bind("mod+backspace", ({ keystroke }) => {
    count.set(0);
    last.set(keystroke);
  }, { when: "notEditing" });
  const keys: [string, string][] = [
    [keymap.label("mod+k"), "Counts"],
    [keymap.label("mod+shift+l"), "Switches the light"],
    [keymap.label("mod+backspace"), "Resets (not while typing)"],
  ];
  return (
    <Card icon="bell" title="Keyboard shortcuts" subtitle="nsh · desktop">
      <View>
        <Each of={keys}>
          {(key, i) => (
            <Row first={i() === 0}>
              <Text style={{ width: 120, fontSize: 14, color: colors.accent, fontFamily: mono }}>{key()[0]}</Text>
              <Text style={{ flex: 1, fontSize: 15, color: colors.text }}>{key()[1]}</Text>
            </Row>
          )}
        </Each>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Badge label={on() ? "Light on" : "Light off"} tone={on() ? "up" : "neutral"} />
        <View style={{ flex: 1 }}>
          <Caption label={`Counted ${count()}`} note={last() || "–"} />
        </View>
      </View>
    </Card>
  );
}

/** A context menu on a right click (desktops: `Menu.popup`). */
function ContextMenu() {
  const chosen = signal("");
  const menu = () =>
    Menu.popup([
      { label: "Copy", onSelect: () => chosen.set("Copy") },
      { label: "Paste", disabled: true },
      { label: "Share", submenu: [{ label: "Mail", onSelect: () => chosen.set("Share > Mail") }] },
    ]);
  return (
    <Card icon="bell" title="Context menu" subtitle="nsh/desktop · right click">
      <View
        testID="menu-target"
        onContextMenu={() => void menu()}
        style={{ height: 72, borderRadius: 12, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" }}
      >
        <Text style={{ fontSize: 14, color: colors.muted }}>{chosen() ? `Chose ${chosen()}` : "Right-click here"}</Text>
      </View>
    </Card>
  );
}

type Post = { id: number; title: string };

function Network() {
  // Loads once asked, and again on each press after: a resource keeps the
  // posts while it loads again, and a failure next to them.
  const asked = signal(false);
  const result = resource(asked, async (_, { signal }) => {
    const started = performance.now();
    const response = await fetch("https://jsonplaceholder.typicode.com/posts?_limit=3", { signal });
    const posts: Post[] = await response.json();
    return { posts, ok: response.ok, line: `HTTP ${response.status} · ${Math.round(performance.now() - started)} ms` };
  });
  const posts = () => result()?.posts ?? [];
  const loading = result.loading;
  const status = (): { text: string; tone: Tone } | null => {
    if (result.loading()) return { text: "loading…", tone: "neutral" };
    if (result.error()) return { text: String(result.error()), tone: "danger" };
    const done = result();
    return done ? { text: done.line, tone: done.ok ? "up" : "danger" } : null;
  };
  const load = () => (asked() ? result.refetch() : asked.set(true));
  return (
    <Card icon="search" title="Network and logs" subtitle="fetch() · console.log">
      <If when={posts().length > 0} else={<Caption label="Three posts from jsonplaceholder.typicode.com" />}>
        <View>
          <Each of={posts()}>
            {(post, i) => (
              <Appear index={i()}>
                <Row first={i() === 0}>
                  <Text style={{ width: 28, fontSize: 13, color: colors.accent, fontVariant: ["tabular-nums"] }}>{`#${post().id}`}</Text>
                  <Text style={{ numberOfLines: 1, flex: 1, fontSize: 15, color: colors.text }}>
                    {post().title}
                  </Text>
                </Row>
              </Appear>
            )}
          </Each>
        </View>
      </If>
      <If when={status()}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: toneColor(status()!.tone) }} />
          <Text style={{ numberOfLines: 2, flex: 1, fontSize: 13, color: toneColor(status()!.tone), fontVariant: ["tabular-nums"] }}>
            {status()!.text}
          </Text>
        </View>
      </If>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button label={loading() ? "Loading…" : "fetch()"} icon="arrow-down" disabled={loading()} onPress={load} />
        </View>
        <View style={{ flex: 1 }}>
          <Button
            label="console.log"
            variant="secondary"
            onPress={() => console.log("hello from the gallery", { at: new Date().toISOString() })}
          />
        </View>
      </View>
      <Text style={{ fontSize: 12, color: colors.faint }}>console.log shows in the terminal of nsh run.</Text>
    </Card>
  );
}

export function System() {
  const sections = [Environment, StatusBarCard, Dialogs, FramesAndTimers, Shortcuts, ContextMenu, Network];
  return <DemoPage cards={sections} />;
}
