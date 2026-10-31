import { type AnimatedValue, cleanup, Clipboard, createAnimatedValue, Easing, effect, LayoutAnimation, openUrl, reduceMotion, signal, Text, token, View } from "nsh";
import { Button as BaseButton, Menu, MenuItem } from "nsh/base";
import { keymap, platform } from "nsh";
import { Icon, type IconName } from "../icons";
import { alpha, Badge, Button, Caption, Card, colors, DemoPage, finish, focusRing, follow, hovered, mono, motion, radius, Spinner, tints, Tip, Toggle } from "../ui";

// `nsh/base`'s `Button` owns presses, the disabled state, keyboard focus and
// the button role; the look is the gallery's (`Button` of `nsh-gallery-ui`):
// a raised neutral, the citrus main action, a quiet ghost, a destructive
// tint, each with its hover, pressed, focus and disabled states. The motion
// is the gallery's too: a press sinks, a new icon or a spinner grows in and
// the label's new width eases in (`motion.control`), all at once with
// reduced motion.

const pointer = platform.desktop;

/** Waits `ms`, cancelled with the component that started it. */
function timers() {
  const pending = new Set<ReturnType<typeof setTimeout>>();
  cleanup(() => pending.forEach(clearTimeout));
  return (ms: number, then: () => void) => {
    const t = setTimeout(() => {
      pending.delete(t);
      then();
    }, ms);
    pending.add(t);
  };
}

/** The next commit's frames ease to their new sizes (a label growing or shrinking), unless motion is reduced. */
const resize = () => {
  if (!reduceMotion()) LayoutAnimation.configureNext({ duration: 220, update: { type: "spring", springDamping: 0.85 } });
};

/**
 * A scale at rest at 1 that bounces a little past it each time `key`
 * changes, so what changed pops; still with reduced motion.
 */
function popOn(key: () => unknown): AnimatedValue {
  const s = createAnimatedValue(1);
  let shown = key();
  effect(() => {
    const next = key();
    if (next === shown) return;
    shown = next;
    if (!reduceMotion()) s.spring(1, { ...motion.move, velocity: 4 });
  });
  return s;
}

/**
 * An icon-only button: its name for screen readers and in a tooltip (with
 * its shortcut on desktops). `on` keeps it chosen (a toggle: a favorite),
 * its icon in the accent and popping as it turns on or off.
 */
function IconButton(props: { icon: IconName; label: string; shortcut?: string; on?: boolean; tone?: "danger"; variant?: "ghost" | "secondary"; onPress: () => void }) {
  const size = pointer ? 28 : 40;
  const press = createAnimatedValue(1);
  const pop = popOn(() => props.on);
  const raised = () => props.variant === "secondary";
  const tint = () => (props.on ? colors.accent : props.tone === "danger" ? colors.danger : raised() ? colors.text : colors.muted);
  return (
    <View
      onPress={props.onPress}
      onPressDown={() => press.spring(0.9, motion.press)}
      onPressUp={() => press.spring(1, motion.press)}
      role="button"
      accessibilityLabel={props.label}
      accessibilityState={props.on === undefined ? undefined : { selected: props.on }}
      tooltip={<Tip label={props.shortcut && pointer ? `${props.label}  ${props.shortcut}` : props.label} />}
      hoverStyle={props.on ? undefined : props.tone === "danger" ? { backgroundColor: tints.danger } : raised() ? finish.hover : hovered()}
      activeStyle={raised() ? finish.pressed : { backgroundColor: alpha(colors.text, 0.1) }}
      focusStyle={focusRing()}
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: radius.control,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: "transparent",
        backgroundColor: props.on ? tints.accent : "transparent",
        ...(raised() && !props.on ? finish.raised : {}),
        transform: [{ scale: press }],
        transitionProperty: "background-color, border-color, box-shadow",
        transitionDuration: 120,
      }}
    >
      <View style={{ transform: [{ scale: pop }] }}>
        <Icon name={props.icon} size={pointer ? 15 : 18} tint={tint()} />
      </View>
    </View>
  );
}

/**
 * A raised button with a run of `tone` filling it from the leading edge as
 * `fill` goes from 0 to 1 (an upload's progress, a held press): the button
 * clips it, and the label stays on top.
 */
function FillButton(props: {
  label: string;
  icon?: IconName;
  busy?: boolean;
  fill: AnimatedValue;
  tone: string;
  tint?: string;
  testID?: string;
  delayLongPress?: number;
  disabled?: boolean;
  onPress?: () => void;
  onPressDown?: () => void;
  onPressUp?: () => void;
  onLongPress?: () => void;
}) {
  const press = createAnimatedValue(1);
  const glyph = follow(() => (props.busy || props.icon ? 1 : 0));
  return (
    <View
      testID={props.testID}
      role="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      delayLongPress={props.delayLongPress}
      onPressDown={() => {
        press.spring(0.97, motion.press);
        props.onPressDown?.();
      }}
      onPressUp={() => {
        press.spring(1, motion.press);
        props.onPressUp?.();
      }}
      hoverStyle={props.disabled ? undefined : finish.hover}
      focusStyle={focusRing()}
      style={{
        alignSelf: "flex-start",
        height: pointer ? 28 : 40,
        paddingHorizontal: pointer ? 12 : 16,
        flexDirection: "row",
        alignItems: "center",
        gap: pointer ? 6 : 8,
        overflow: "hidden",
        borderRadius: radius.control,
        borderCurve: "continuous",
        borderWidth: 1,
        ...finish.raised,
        opacity: props.disabled ? 0.4 : 1,
        transform: [{ scale: press }],
        transitionProperty: "background-color, border-color, box-shadow, opacity",
        transitionDuration: 120,
      }}
    >
      <View
        style={{
          pointerEvents: "none",
          position: "absolute",
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
          backgroundColor: props.tone,
          transformOrigin: "left",
          transform: [{ scaleX: props.fill }],
        }}
      />
      <If when={props.busy || props.icon}>
        <View style={{ opacity: glyph }}>
          <If when={props.busy} else={<Icon name={props.icon!} size={pointer ? 14 : 16} tint={props.tint ?? colors.text} />}>
            <Spinner size={pointer ? 13 : 15} tint={props.tint ?? colors.text} />
          </If>
        </View>
      </If>
      <Text style={{ fontSize: pointer ? 13 : 15, fontWeight: "500", color: props.tint ?? colors.text, fontVariant: ["tabular-nums"] }}>{props.label}</Text>
    </View>
  );
}

/** The menu's popup on desktops (one edge, a soft shadow), a sheet at the bottom on touch screens. */
const menuSurface = () =>
  pointer
    ? { borderRadius: 10, borderWidth: 1, padding: 4, minWidth: 260, ...finish.menu }
    : { backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 10, paddingTop: 10, paddingBottom: 34 };

type Strategy = { value: "merge" | "squash" | "rebase"; label: string; note: string; done: string };

const strategies: Strategy[] = [
  { value: "merge", label: "Merge", note: "Every commit joins main with a merge commit", done: "Merged" },
  { value: "squash", label: "Squash and merge", note: "The 12 commits become one on main", done: "Squashed" },
  { value: "rebase", label: "Rebase and merge", note: "The commits are replayed on top of main", done: "Rebased" },
];

/**
 * Button: the kinds a decision area uses and their sizes, icon buttons with
 * tooltips, a split button with a menu, work that takes a while (a spinner,
 * a progress fill, a check when done), a copy button, a destructive action
 * held to confirm, and a button disabled with its reason shown.
 */
export function ButtonDemo() {
  const last = signal("—");
  const after = timers();

  function Kinds() {
    return (
      <Card title="Kinds" subtitle="One main action; the others quieter">
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <Button label="Save" onPress={() => last.set("pressed Save")} />
          <Button label="Duplicate" variant="secondary" onPress={() => last.set("pressed Duplicate")} />
          <Button label="Cancel" variant="ghost" onPress={() => last.set("pressed Cancel")} />
          <Button label="Delete" variant="danger" onPress={() => last.set("pressed Delete")} />
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={{ fontSize: pointer ? 13 : 15, color: colors.muted }}>A link opens a resource outside the app:</Text>
          <View
            role="link"
            accessibilityLabel="Button guidelines"
            onPress={() => void openUrl("https://nsh.dev/docs/design-guides").then(({ opened }) => last.set(opened ? "opened the guidelines" : "No app opens links"))}
            hoverStyle={{ opacity: 0.8 }}
            activeStyle={{ opacity: 0.6 }}
            focusStyle={focusRing()}
            style={{ cursor: "pointer", flexDirection: "row", alignItems: "center", gap: 3, borderRadius: 4, transitionProperty: "opacity", transitionDuration: 120 }}
          >
            <Text style={{ fontSize: pointer ? 13 : 15, fontWeight: "500", color: colors.accent, textDecorationLine: "underline" }}>
              Guidelines
            </Text>
            <Text style={{ fontSize: pointer ? 12 : 14, color: colors.accent }}>↗</Text>
          </View>
        </View>
        <Caption label={pointer ? "Hover, press and Tab to each: one focus ring for every control" : "Press each: it sinks under the finger"} />
      </Card>
    );
  }

  function Sizes() {
    const sizes = [
      { size: "small", label: "Small" },
      { size: "regular", label: "Regular" },
      { size: "large", label: "Large" },
    ] as const;
    return (
      <Card title="Sizes" subtitle={pointer ? "24, 28 and 34 points tall" : "36, 40 and 48 points tall"}>
        <Each of={[...sizes]}>
          {(s) => (
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              <Text style={{ width: 64, fontSize: 12, color: colors.faint, fontFamily: mono }}>{s().size}</Text>
              <Button size={s().size} label="Continue" onPress={() => last.set(`pressed ${s().label} Continue`)} />
              <Button size={s().size} label="Add" icon="plus" variant="secondary" onPress={() => last.set(`pressed ${s().label} Add`)} />
              <Button size={s().size} label="Skip" variant="ghost" onPress={() => last.set(`pressed ${s().label} Skip`)} />
            </View>
          )}
        </Each>
      </Card>
    );
  }

  function Icons() {
    const starred = signal(false);
    const pinned = signal(true);
    const star = () => {
      starred.set(!starred());
      last.set(starred() ? "added to favorites" : "removed from favorites");
    };
    // The shortcut the tooltip shows works too.
    keymap.bind("mod+alt+f", star);
    const key = pointer ? keymap.label("mod+alt+f") : undefined;
    return (
      <Card title="Icon buttons" subtitle={pointer ? "Rest the pointer on one for its name and shortcut" : "Each has a name for screen readers"}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ fontSize: pointer ? 14 : 16, fontWeight: "600", color: colors.text }}>Harbor at dawn.jpg</Text>
            <Text style={{ fontSize: pointer ? 12 : 13, color: colors.faint, fontVariant: ["tabular-nums"] }}>4032 × 3024 · 3.2 MB</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: pointer ? 2 : 4 }}>
            <IconButton icon="star" label={starred() ? "Remove from favorites" : "Add to favorites"} shortcut={key} on={starred()} onPress={star} />
            <IconButton icon="share" label="Share…" onPress={() => last.set("pressed Share")} />
            <IconButton icon="download" label="Download" onPress={() => last.set("pressed Download")} />
            <IconButton icon="trash" label="Move to the trash" tone="danger" onPress={() => last.set("pressed Move to the trash")} />
          </View>
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <IconButton icon="plus" label="New file" variant="secondary" onPress={() => last.set("pressed New file")} />
          <IconButton icon="search" label="Search" variant="secondary" onPress={() => last.set("pressed Search")} />
          <IconButton icon="sidebar" label={pinned() ? "Hide the sidebar" : "Show the sidebar"} variant="secondary" on={pinned()} onPress={() => pinned.set(!pinned())} />
          <View style={{ flex: 1 }} />
          <Button label="Play" icon="play" variant="secondary" onPress={() => last.set("pressed Play")} />
        </View>
      </Card>
    );
  }

  function Split() {
    const strategy = signal<Strategy>(strategies[1]);
    const state = signal<"idle" | "busy" | "done">("idle");
    const open = signal(false);
    const pop = popOn(() => state() === "done");
    const merge = () => {
      if (state() !== "idle") return;
      resize();
      state.set("busy");
      last.set(`${strategy().label}: started`);
      after(1200, () => {
        resize();
        state.set("done");
        last.set(`${strategy().label}: done`);
      });
    };
    const label = () => (state() === "busy" ? "Merging…" : state() === "done" ? strategy().done : strategy().label);
    // Each half sinks as it is pressed; the pair shares one silhouette.
    const half = { height: pointer ? 28 : 40, flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "center" as const };
    return (
      <Card
        title="Split button"
        subtitle="The main action, its variants in a menu"
        right={<Badge label={state() === "done" ? "Merged" : "Open"} tone={state() === "done" ? "up" : "neutral"} />}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "stretch",
              borderRadius: radius.control,
              borderCurve: "continuous",
              borderWidth: 1,
              overflow: "hidden",
              ...(state() === "done" ? { backgroundColor: tints.up, backgroundImage: "none", borderColor: alpha(colors.up, 0.4), boxShadow: "none" } : finish.accent),
              transitionProperty: "background-color, border-color, box-shadow",
              transitionDuration: reduceMotion() ? 0 : 200,
            }}
          >
            <BaseButton
              onPress={merge}
              disabled={state() === "done"}
              accessibilityLabel={label()}
              hoverStyle={state() === "idle" ? { backgroundColor: alpha("#ffffff", 0.12) } : undefined}
              activeStyle={state() === "idle" ? { backgroundColor: alpha("#000000", 0.08) } : undefined}
              focusStyle={focusRing(-2)}
              style={{ ...half, gap: pointer ? 6 : 8, paddingHorizontal: pointer ? 12 : 16 }}
            >
              <View style={{ transform: [{ scale: pop }] }}>
                <If when={state() === "busy"} else={<Icon name={state() === "done" ? "check" : "merge"} size={pointer ? 14 : 16} tint={state() === "done" ? colors.up : colors.onAccent} />}>
                  <Spinner size={pointer ? 13 : 15} tint={colors.onAccent} />
                </If>
              </View>
              <Text style={{ fontSize: pointer ? 13 : 15, fontWeight: "500", color: state() === "done" ? colors.up : colors.onAccent }}>{label()}</Text>
            </BaseButton>
            <View style={{ width: 1, backgroundColor: state() === "done" ? alpha(colors.up, 0.3) : alpha(colors.onAccent, 0.22) }} />
            <Menu
              align="end"
              offset={6}
              margin={8}
              open={open()}
              onOpenChange={({ open: o }) => open.set(o)}
              popupStyle={menuSurface()}
              backdropStyle={{ backgroundColor: "rgba(0,0,0,0.45)" }}
              trigger={
                <View
                  role="button"
                  accessibilityLabel="Merge options"
                  disabled={state() !== "idle"}
                  hoverStyle={{ backgroundColor: alpha("#ffffff", 0.12) }}
                  activeStyle={{ backgroundColor: alpha("#000000", 0.08) }}
                  focusStyle={focusRing(-2)}
                  style={{ ...half, width: pointer ? 26 : 40, backgroundColor: open() ? alpha("#000000", 0.1) : "transparent" }}
                >
                  <View style={{ alignSelf: "stretch", flexGrow: 1, alignItems: "center", justifyContent: "center", transform: [{ rotate: open() ? "180deg" : "0deg" }], transitionProperty: "transform", transitionDuration: reduceMotion() ? 0 : 180 }}>
                    <Icon name="chevron-down" size={pointer ? 12 : 14} tint={state() === "done" ? colors.up : colors.onAccent} weight={2} />
                  </View>
                </View>
              }
            >
              <Each of={strategies}>
                {(s) => (
                  <MenuItem
                    onSelect={() => {
                      resize();
                      strategy.set(s());
                      last.set(`chose ${s().label}`);
                    }}
                    hoverStyle={{ backgroundColor: token("accent") }}
                    activeStyle={{ backgroundColor: alpha(colors.text, 0.1) }}
                    style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 8, paddingVertical: pointer ? 6 : 10, borderRadius: pointer ? 6 : 10 }}
                  >
                    <View style={{ flexGrow: 1, flexShrink: 1, gap: 2 }}>
                      <Text style={{ fontSize: pointer ? 13 : 16, fontWeight: "500", color: colors.text }}>{s().label}</Text>
                      <Text style={{ fontSize: pointer ? 12 : 14, color: colors.muted }}>{s().note}</Text>
                    </View>
                    {/* The check at the trailing edge, as every menu's. */}
                    <View style={{ width: 16, paddingTop: 1, alignItems: "center" }}>
                      <If when={strategy().value === s().value}>
                        <Icon name="check" size={14} tint={colors.accent} weight={2} />
                      </If>
                    </View>
                  </MenuItem>
                )}
              </Each>
            </Menu>
          </View>
          <If when={state() === "done"}>
            <Button
              label="Reopen"
              variant="ghost"
              onPress={() => {
                resize();
                state.set("idle");
                last.set("reopened");
              }}
            />
          </If>
        </View>
        <Caption label="The chevron's menu picks how the main action merges" note={strategy().value} />
      </Card>
    );
  }

  function Loading() {
    const save = signal<"idle" | "busy" | "done">("idle");
    const progress = signal<number | null>(null);
    const fill = createAnimatedValue(0);
    const doneUpload = signal(false);
    effect(() => {
      const p = progress();
      if (p === null) return;
      if (reduceMotion()) fill.set(p);
      else fill.timing(p, { duration: 180, easing: Easing.out(Easing.cubic) });
    });
    const runSave = () => {
      if (save() !== "idle") return;
      save.set("busy");
      last.set("Save: started");
      after(1200, () => {
        save.set("done");
        last.set("Save: done");
        after(1800, () => save.set("idle"));
      });
    };
    const runUpload = () => {
      if (progress() !== null) return;
      resize();
      doneUpload.set(false);
      progress.set(0);
      last.set("Upload: started");
      const step = () => {
        const next = Math.min(1, (progress() ?? 0) + 0.12 + ((progress() ?? 0) * 7919) % 0.08);
        progress.set(next);
        if (next < 1) after(160, step);
        else
          after(300, () => {
            resize();
            progress.set(null);
            fill.set(0);
            doneUpload.set(true);
            last.set("Upload: done");
          });
      };
      after(160, step);
    };
    return (
      <Card title="Work that takes a while" subtitle="No second press while it runs; the result shows on the button">
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <Button
            label={save() === "busy" ? "Saving…" : save() === "done" ? "Saved" : "Save changes"}
            icon={save() === "done" ? "check" : undefined}
            busy={save() === "busy"}
            onPress={runSave}
          />
          <FillButton
            testID="upload"
            label={progress() !== null ? `Uploading ${Math.round((progress() ?? 0) * 100)}%` : doneUpload() ? "Uploaded" : "Upload photos"}
            icon={doneUpload() ? "check" : "arrow-up"}
            busy={progress() !== null}
            fill={fill}
            tone={tints.accent}
            tint={doneUpload() ? colors.up : undefined}
            onPress={runUpload}
          />
        </View>
        <Caption label="A spinner while waiting, a progress fill when the amount is known" note={save() === "busy" || progress() !== null ? "busy" : "idle"} />
      </Card>
    );
  }

  function Copy() {
    const copied = signal<string | null>(null);
    const copy = (what: string, text: string) => {
      void Clipboard.writeText(text);
      copied.set(what);
      last.set(`copied ${what}`);
      after(1600, () => copied() === what && copied.set(null));
    };
    const line = (props: { what: string; text: string }) => (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingLeft: 12,
          paddingRight: 4,
          height: pointer ? 36 : 48,
          borderRadius: radius.control,
          borderWidth: 1,
          backgroundColor: colors.field,
          ...finish.field,
        }}
      >
        <Text style={{ flex: 1, numberOfLines: 1, fontSize: pointer ? 12 : 14, color: colors.text, fontFamily: mono }}>{props.text}</Text>
        <IconButton icon={copied() === props.what ? "check" : "copy"} label={copied() === props.what ? "Copied" : `Copy the ${props.what}`} on={copied() === props.what} onPress={() => copy(props.what, props.text)} />
      </View>
    );
    return (
      <Card title="Copy" subtitle="The icon turns into a check for a moment">
        {line({ what: "command", text: "nsh init my-app --template ts" })}
        {line({ what: "key", text: "pk_live_51Hx…9fQ2" })}
        <Button
          label={copied() === "link" ? "Copied" : "Copy invite link"}
          icon={copied() === "link" ? "check" : "link"}
          variant="secondary"
          onPress={() => copy("link", "https://nsh.dev/join/7f3a")}
        />
      </Card>
    );
  }

  function Hold() {
    const HOLD = 1200;
    const fill = createAnimatedValue(0);
    const state = signal<"idle" | "holding" | "done">("idle");
    const nudge = signal(false);
    const pop = popOn(() => state() === "done");
    return (
      <Card title="Hold to confirm" subtitle="A destructive action that cannot be undone">
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ fontSize: pointer ? 14 : 16, fontWeight: "600", color: colors.text }}>Delete “Q3 roadmap”</Text>
            <Text style={{ fontSize: pointer ? 12 : 13, color: colors.muted }}>Its 48 cards and their comments go with it.</Text>
          </View>
          <If
            when={state() !== "done"}
            else={
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, transform: [{ scale: pop }] }}>
                <Icon name="check" size={pointer ? 14 : 16} tint={colors.danger} />
                <Text style={{ fontSize: pointer ? 13 : 15, fontWeight: "500", color: colors.danger }}>Deleted</Text>
                <Button label="Restore" variant="ghost" size="small" onPress={() => {
                  resize();
                  state.set("idle");
                  last.set("restored Q3 roadmap");
                }} />
              </View>
            }
          >
            <FillButton
              testID="hold"
              label={state() === "holding" ? "Keep holding" : "Hold to delete"}
              icon="trash"
              fill={fill}
              tone={alpha(colors.danger, 0.28)}
              tint={colors.danger}
              delayLongPress={HOLD}
              onPress={() => {
                // Let go early: say how it works.
                resize();
                nudge.set(true);
                after(2400, () => nudge.set(false));
              }}
              onPressDown={() => {
                state.set("holding");
                fill.timing(1, { duration: HOLD, easing: Easing.linear });
              }}
              onPressUp={() => {
                if (state() === "done") return;
                state.set("idle");
                fill.spring(0, motion.control);
              }}
              onLongPress={() => {
                resize();
                state.set("done");
                fill.set(0);
                nudge.set(false);
                last.set("deleted Q3 roadmap");
              }}
            />
          </If>
        </View>
        <If when={nudge()}>
          <Text style={{ fontSize: pointer ? 12 : 13, color: colors.danger }}>Hold the button for a second to delete.</Text>
        </If>
      </Card>
    );
  }

  function Disabled() {
    const title = signal(false);
    const terms = signal(false);
    const off = signal(false);
    const reason = () => (!title() ? "Add a title first" : !terms() ? "Accept the terms to publish" : null);
    const published = signal(false);
    return (
      <Card title="Disabled, with its reason" subtitle="Say what to do, next to the button" right={<Toggle value={off()} onChange={(v) => off.set(v)} label="Disable all" />}>
        <View style={{ gap: 2 }}>
          <Row label="The post has a title" value={title()} onChange={(v) => {
            resize();
            title.set(v);
          }} />
          <Row label="I accept the terms" value={terms()} onChange={(v) => {
            resize();
            terms.set(v);
          }} />
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
          <Button label={published() ? "Published" : "Publish"} icon={published() ? "check" : undefined} disabled={off() || !!reason() || published()} onPress={() => {
            published.set(true);
            last.set("published");
            after(2000, () => published.set(false));
          }} />
          <Button label="Archive" variant="secondary" disabled={off()} onPress={() => last.set("pressed Archive")} />
          <If when={reason()}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Icon name="lock" size={pointer ? 12 : 14} tint={colors.faint} />
              <Text style={{ fontSize: pointer ? 12 : 13, color: colors.muted }}>{reason()}</Text>
            </View>
          </If>
        </View>
        <Caption label="A disabled button takes no press, no hover and no focus" />
      </Card>
    );
  }

  function Last() {
    return (
      <Card title="Last event">
        <Text style={{ fontSize: 13, color: colors.text, fontFamily: mono }}>{last()}</Text>
      </Card>
    );
  }

  return <DemoPage cards={[Kinds, Split, Loading, Icons, Hold, Copy, Sizes, Disabled, Last]} />;
}

/** A label and its switch. */
function Row(props: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: pointer ? 32 : 44 }}>
      <Text style={{ flex: 1, fontSize: pointer ? 13 : 15, color: colors.text }}>{props.label}</Text>
      <Toggle value={props.value} onChange={props.onChange} label={props.label} />
    </View>
  );
}
