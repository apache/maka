import { cleanup, computed, type JSX, signal, Text, View } from "nsh";
import { Checkbox, Collapsible, Combobox, NumberInput, OtpInput, Progress, Radio, RadioGroup, Select, type SelectGroup, type SelectItemState, Slider, Switch, Tab, Tabs } from "nsh/base";
import { reduceMotion } from "nsh";
import { platform } from "nsh";
import { Icon } from "../icons";
import { alpha, Badge, Button, Caption, Card, colors, DemoPage, finish, focusRing, hovered, mono, radius, sliderFill, sliderLook, sliderValueClass, sliderValueStyle, switchLook, tints, toneColor } from "../ui";

// `nsh/base`'s controls own presses, keys, the disabled state and what
// screen readers say; every value is the app's, and so is the look: the
// gallery's own here, with its hover and keyboard focus ring (`hovered`,
// `focusRing`) on every control, and no motion with reduced motion.

/**
 * The sizes of the page. Touch screens take the standard tier (44 pt and
 * more to press); a pointer the compact one desktops' settings and filters
 * use: smaller controls, rows and type, whatever the window's width.
 */
const size =
  platform.idiom === "desktop"
    ? { row: 40, padding: 6, gap: 10, label: 14, detail: 12, control: 16, corner: 5, check: 12, dot: 6, tabs: 30, line: 32, clear: 16, switch: "small" as const }
    : { row: 56, padding: 8, gap: 12, label: 15, detail: 13, control: 22, corner: 7, check: 16, dot: 8, tabs: 40, line: 44, clear: 20, switch: "regular" as const };
const pointer = platform.idiom === "desktop";

/** A control's row: the control and its label, the whole row pressable. */
const row = (first: boolean) => ({
  minHeight: size.row,
  flexDirection: "row" as const,
  alignItems: "center" as const,
  gap: size.gap,
  paddingVertical: size.padding,
  borderTopWidth: first ? 0 : 1,
  borderTopColor: colors.line,
});
/** How far a row's hover fill reaches past its content on each side, and its corners. */
const BLEED = 8;

/**
 * A row that takes the pointer's hover: `row`'s, its fill reaching `BLEED`
 * past the content on both sides with rounded corners, and the content where
 * it was (`start`: more room before it). The hairline above it is a
 * `Divider`, the length `row`'s top border had; the point it took stays in
 * the padding, so nothing moves.
 */
const hoverRow = (first: boolean, start = 0) => ({
  ...row(true),
  marginHorizontal: -BLEED,
  paddingStart: BLEED + start,
  paddingEnd: BLEED,
  paddingTop: size.padding + (first ? 0 : 1),
  borderRadius: BLEED,
});

/** The hairline above a `hoverRow` that is not the first. */
function Divider(props: { show: boolean }) {
  return (
    <If when={props.show}>
      <View style={{ position: "absolute", top: 0, left: BLEED, right: BLEED, height: 1, backgroundColor: colors.line }} />
    </If>
  );
}

const pressed = { opacity: 0.7 };
const dimmed = { opacity: 0.4 };

/** The fill of a box or ring that is on (the main button's citrus finish:
 * its darker olive edge and lit top), and of one that is off. */
const fill = (on: boolean) =>
  on
    ? { ...finish.light }
    : { backgroundColor: colors.field, backgroundImage: "none", borderColor: colors.fieldBorder, boxShadow: finish.field.boxShadow };

type Mark = "check" | "dash" | null;

/** A checkbox's box: empty, or citrus with a check or a dash. */
const box = (mark: Mark) => ({
  width: size.control,
  height: size.control,
  borderRadius: size.corner,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  borderWidth: 1,
  ...fill(mark !== null),
});

/** What a checkbox's box shows: a check or a dash, drawn with the same bold pen (about 2 pt at the desktop size). */
const markWeight = 3.2;
function BoxMark(props: { mark: Mark }) {
  return (
    <>
      <If when={props.mark === "check"}>
        <Icon name="check" size={size.check} tint={colors.onAccent} weight={markWeight} />
      </If>
      <If when={props.mark === "dash"}>
        <Icon name="minus" size={size.check} tint={colors.onAccent} weight={markWeight} />
      </If>
    </>
  );
}

/** A radio's ring: empty, or citrus with a dot. */
function Ring(props: { on: boolean }) {
  return (
    <View
      style={{ width: size.control, height: size.control, borderRadius: size.control / 2, alignItems: "center", justifyContent: "center", borderWidth: 1, ...fill(props.on) }}
    >
      <If when={props.on}>
        <View style={{ width: size.dot, height: size.dot, borderRadius: size.dot / 2, backgroundColor: colors.onAccent }} />
      </If>
    </View>
  );
}

/** A label, and a quieter line under it. */
function Label(props: { label: string; detail?: string }) {
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <Text style={{ fontSize: size.label, color: colors.text }}>{props.label}</Text>
      <If when={props.detail}>
        <Text style={{ fontSize: size.detail, color: colors.muted }}>{props.detail}</Text>
      </If>
    </View>
  );
}

const KINDS: { name: string; count: number }[] = [
  { name: "Photos", count: 1204 },
  { name: "Videos", count: 86 },
  { name: "Screenshots", count: 312 },
  { name: "Live Photos", count: 48 },
];

const PLANS: { name: string; detail: string; price: string; disabled?: boolean }[] = [
  { name: "Free", detail: "One device, 5 GB", price: "$0" },
  { name: "Plus", detail: "Three devices, 200 GB", price: "$3 / mo" },
  { name: "Team", detail: "A shared library, 2 TB", price: "$12 / mo" },
  { name: "Enterprise", detail: "Set up by your organization", price: "—", disabled: true },
];

const SECTIONS: { name: string; rows: [string, string][]; disabled?: boolean }[] = [
  {
    name: "Overview",
    rows: [
      ["Visitors", "12,480"],
      ["Sign-ups", "342"],
      ["Conversion", "2.74%"],
    ],
  },
  {
    name: "Activity",
    rows: [
      ["Deployed to production", "09:41"],
      ["Invoice paid", "08:15"],
      ["A member joined", "07:02"],
    ],
  },
  {
    name: "Members",
    rows: [
      ["Ada Lovelace", "Owner"],
      ["Grace Hopper", "Admin"],
      ["Alan Turing", "Member"],
    ],
  },
  { name: "Billing", rows: [], disabled: true },
];

const USAGE: [string, string][] = [
  ["Photos", "120 GB"],
  ["Apps", "54 GB"],
  ["System", "38 GB"],
];

const count = (n: number) => n.toLocaleString("en-US");

const SORTS = [
  { value: "newest", title: "Newest first" },
  { value: "oldest", title: "Oldest first" },
  { value: "name", title: "Name" },
  { value: "size", title: "Size" },
  { value: "kind", title: "Kind" },
];

const FONTS = [
  { value: "helvetica", title: "Helvetica", group: "Sans serif" },
  { value: "inter", title: "Inter", group: "Sans serif" },
  { value: "roboto", title: "Roboto", group: "Sans serif" },
  { value: "source-sans", title: "Source Sans", group: "Sans serif" },
  { value: "georgia", title: "Georgia", group: "Serif" },
  { value: "merriweather", title: "Merriweather", group: "Serif" },
  { value: "playfair", title: "Playfair Display", group: "Serif", disabled: true },
  { value: "times", title: "Times New Roman", group: "Serif" },
  { value: "fira-code", title: "Fira Code", group: "Monospace" },
  { value: "jetbrains-mono", title: "JetBrains Mono", group: "Monospace" },
  { value: "menlo", title: "Menlo", group: "Monospace" },
  { value: "sf-mono", title: "SF Mono", group: "Monospace" },
];

const LANGUAGES = [
  { value: "en", title: "English" },
  { value: "de", title: "Deutsch" },
];

const TOPICS = [
  { value: "layout", title: "Layout", group: "Core" },
  { value: "text", title: "Text", group: "Core" },
  { value: "animation", title: "Animation", group: "Core" },
  { value: "ios", title: "iOS", group: "Platforms" },
  { value: "android", title: "Android", group: "Platforms" },
  { value: "desktop", title: "Desktop", group: "Platforms" },
  { value: "web", title: "Web", group: "Platforms" },
  { value: "legacy", title: "Legacy", group: "Platforms", disabled: true },
];

const REVIEWERS = [
  { value: "ada", title: "Ada" },
  { value: "grace", title: "Grace" },
  { value: "linus", title: "Linus" },
];

const titleOf = (items: { value: string; title: string }[], value: string | null) => items.find((i) => i.value === value)?.title ?? "None";

/** The controls, one demo each in the sidebar. */
export type Control =
  | "Switch"
  | "Checkbox"
  | "Radio"
  | "Tabs"
  | "Select"
  | "Combobox"
  | "Collapsible"
  | "Progress"
  | "Slider"
  | "NumberInput"
  | "OtpInput";

/**
 * One of `nsh/base`'s controls (`Switch`, `Checkbox`, `Radio` and
 * `RadioGroup`, `Tab` and `Tabs`, `Select`, `Combobox`, `Collapsible`, `Progress`, `Slider`) in
 * the settings, filters, pickers, section switchers, choices and disclosures apps use
 * it for, above the last event it reported.
 */
export function Controls(props: { show: Control }) {
  const last = signal("—");

  function Settings() {
    const notifications = signal(true);
    const badges = signal(true);
    const haptics = signal(false);
    const lowData = signal(false);
    function Setting(props: { label: string; detail: string; on: boolean; set: (on: boolean) => void; disabled?: boolean; first?: boolean }) {
      const look = switchLook(() => props.on, size.switch);
      return (
        <Switch
          checked={props.on}
          disabled={props.disabled}
          onChange={({ checked: on }) => {
            props.set(on);
            last.set(`${props.label}: ${on ? "on" : "off"}`);
          }}
          // The track at the trailing edge, after the label.
          style={{ ...hoverRow(!!props.first), flexDirection: "row-reverse" }}
          activeStyle={pressed}
          hoverStyle={props.disabled ? undefined : hovered()}
          focusStyle={focusRing()}
          disabledStyle={dimmed}
          trackStyle={look.trackStyle}
          thumbStyle={look.thumbStyle}
        >
          <Divider show={!props.first} />
          <Label label={props.label} detail={props.detail} />
        </Switch>
      );
    }
    return (
      <Card icon="controls" title="Switch" subtitle="Settings that take effect at once">
        <View>
          <Setting
            first
            label="Notifications"
            detail={notifications() ? "Banners, sounds and badges" : "Off"}
            on={notifications()}
            set={(on) => notifications.set(on)}
          />
          <Setting
            label="Badges"
            detail={notifications() ? "The unread count on the icon" : "Turn on notifications first"}
            on={badges()}
            disabled={!notifications()}
            set={(on) => badges.set(on)}
          />
          <Setting label="Haptics" detail="A tap under the finger as values change" on={haptics()} set={(on) => haptics.set(on)} />
          <Setting label="Low data mode" detail={lowData() ? "Images load at a lower quality" : "Images load in full"} on={lowData()} set={(on) => lowData.set(on)} />
        </View>
      </Card>
    );
  }

  function Filter() {
    const shown = signal<string[]>(["Photos", "Videos", "Live Photos"]);
    const has = (name: string) => shown().includes(name);
    const total = computed(() => KINDS.filter((k) => has(k.name)).reduce((n, k) => n + k.count, 0));
    const all = () => shown().length === KINDS.length;
    const mark = (): Mark => (all() ? "check" : shown().length > 0 ? "dash" : null);
    return (
      <Card icon="controls" title="Checkbox" subtitle="A filter: “Select all” shows a partial selection" right={<Badge label={`${shown().length} of ${KINDS.length}`} />}>
        <View>
          <Checkbox
            checked={all()}
            indeterminate={mark() === "dash"}
            onChange={({ checked: on }) => {
              shown.set(on ? KINDS.map((k) => k.name) : []);
              last.set(`Select all: ${on}`);
            }}
            style={hoverRow(true)}
            activeStyle={pressed}
            hoverStyle={hovered()}
            focusStyle={focusRing()}
            indicatorStyle={box(mark())}
            indicator={<BoxMark mark={mark()} />}
          >
            <Text style={{ flex: 1, fontSize: size.label, fontWeight: "600", color: colors.text }}>Select all</Text>
          </Checkbox>
          <Each of={KINDS}>
            {(kind) => (
              <Checkbox
                checked={has(kind().name)}
                onChange={({ checked: on }) => {
                  shown.set(on ? KINDS.map((k) => k.name).filter((n) => n === kind().name || has(n)) : shown().filter((n) => n !== kind().name));
                  last.set(`${kind().name}: ${on}`);
                }}
                // One level under "Select all": the boxes line up with its label.
                style={hoverRow(false, size.control + size.gap)}
                activeStyle={pressed}
                hoverStyle={hovered()}
                focusStyle={focusRing()}
                indicatorStyle={box(has(kind().name) ? "check" : null)}
                indicator={<BoxMark mark={has(kind().name) ? "check" : null} />}
              >
                <Divider show />
                <Text style={{ flex: 1, fontSize: size.label, color: colors.text }}>{kind().name}</Text>
                <Text style={{ fontSize: size.detail, color: colors.faint, fontVariant: ["tabular-nums"] }}>{count(kind().count)}</Text>
              </Checkbox>
            )}
          </Each>
        </View>
        <Caption label={shown().length ? `Showing ${count(total())} items` : "Nothing to show"} />
      </Card>
    );
  }

  function Plans() {
    const plan = signal("Plus");
    const chosen = () => PLANS.find((p) => p.name === plan())!;
    return (
      <Card icon="controls" title="Radio" subtitle="A plan picker: one of a small set, all in view">
        <RadioGroup>
          <Each of={PLANS}>
            {(p, i) => (
              <Radio
                checked={plan() === p().name}
                disabled={p().disabled}
                onChange={() => {
                  plan.set(p().name);
                  last.set(`Plan: ${p().name}`);
                }}
                style={hoverRow(i() === 0)}
                activeStyle={pressed}
                hoverStyle={p().disabled ? undefined : hovered()}
                focusStyle={focusRing()}
                disabledStyle={dimmed}
              >
                <Divider show={i() !== 0} />
                <Ring on={plan() === p().name} />
                <Label label={p().name} detail={p().detail} />
                <Text style={{ fontSize: size.label, color: plan() === p().name ? colors.text : colors.muted, fontVariant: ["tabular-nums"] }}>{p().price}</Text>
              </Radio>
            )}
          </Each>
        </RadioGroup>
        {/* The commit of the picker: under it on a phone, at its trailing edge with a pointer. */}
        <View style={{ alignItems: pointer ? "flex-end" : "stretch" }}>
          <Button
            label={`Continue with ${plan()}`}
            size={pointer ? "small" : "regular"}
            onPress={() => last.set(`Continue: ${chosen().name}, ${chosen().price}`)}
          />
        </View>
      </Card>
    );
  }

  function Sections() {
    const section = signal("Overview");
    const shown = () => SECTIONS.find((s) => s.name === section())!;
    // The track's padding and border: a tab is a pill inside them.
    const inner = size.tabs - 2 * (3 + 1);
    return (
      <Card icon="controls" title="Tabs" subtitle="A section switcher: the app shows the selected one">
        <Tabs
          style={{
            height: size.tabs,
            flexDirection: "row",
            gap: 2,
            padding: 3,
            borderRadius: size.tabs / 2,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.inset,
            boxShadow: finish.track.boxShadow,
          }}
        >
          <Each of={SECTIONS}>
            {(s) => (
              <Tab
                selected={section() === s().name}
                disabled={s().disabled}
                onPress={() => {
                  section.set(s().name);
                  last.set(`Tab: ${s().name}`);
                }}
                style={{ flex: 1, borderRadius: inner / 2, borderWidth: 1, borderColor: "transparent", alignItems: "center", justifyContent: "center" }}
                selectedStyle={finish.pill}
                hoverStyle={s().disabled || section() === s().name ? undefined : hovered()}
                focusStyle={focusRing()}
                disabledStyle={dimmed}
              >
                <Text style={{ numberOfLines: 1, fontSize: 13, fontWeight: "500", color: section() === s().name ? colors.text : colors.muted }}>
                  {s().name}
                </Text>
              </Tab>
            )}
          </Each>
        </Tabs>
        <View>
          <Each of={shown().rows}>
            {(r, i) => (
              <View style={{ ...row(i() === 0), minHeight: size.line, paddingVertical: 0 }}>
                <Text style={{ flex: 1, fontSize: size.label, color: colors.text }}>{r()[0]}</Text>
                <Text style={{ fontSize: size.label, color: colors.muted, fontVariant: ["tabular-nums"] }}>{r()[1]}</Text>
              </View>
            )}
          </Each>
        </View>
      </Card>
    );
  }

  // The lists' look, shared by the select's and the combobox's cards.
  /** The list: a popup at the trigger with a pointer, as the menus'; a sheet at the bottom on a touch screen. */
  const surface = () =>
    pointer
      ? { backgroundColor: colors.raised, borderRadius: radius.inset, borderWidth: 1, borderColor: colors.border, padding: 6, ...finish.raised }
      : { backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 10, paddingTop: 10, paddingBottom: 34, maxHeight: "70%" as const };
  const backdrop = { backgroundColor: "rgba(0,0,0,0.45)" };
  /** The clear button's inset from the trigger's end: centered where the chevron's lane is. The button is in the
      select's view, outside the trigger, so its inset counts the trigger's 1 pt border too. */
  const clearInset = 1 + 10 + size.check / 4 - size.clear / 2;
  /** The trigger: the chosen title and a chevron that turns while the list is open, its border lit then. */
  function Picker(props: { title: string; open: boolean; disabled?: boolean; placeholder?: boolean; clearable?: boolean }) {
    return (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          height: size.line,
          paddingLeft: 10,
          // Room for the clear button, which goes over the trigger's end in place of the chevron.
          paddingRight: props.clearable ? clearInset + size.clear + 8 : 10,
          borderRadius: radius.control,
          borderWidth: 1,
          borderColor: props.open ? colors.faint : colors.border,
          backgroundColor: colors.raised,
          ...finish.raised,
          // Dimmed while the select is: the app knows, as it passes `disabled`.
          opacity: props.disabled ? dimmed.opacity : 1,
        }}
        hoverStyle={props.disabled ? undefined : { borderColor: colors.faint }}
        activeStyle={pressed}
        focusStyle={focusRing()}
        disabledStyle={dimmed}
      >
        <Text style={{ numberOfLines: 1, fontSize: size.label, color: props.placeholder ? colors.faint : colors.text }}>{props.title}</Text>
        {/* The chevron's icon box, taking only the room of its stroke (half the box) in the row, so it turns
            about its own center; it points down, and up while open. */}
        <View
          class="transition-transform duration-150 motion-reduce:transition-none"
          style={{ display: props.clearable ? "none" : "flex", marginHorizontal: -size.check / 4, transform: [{ rotate: props.open ? "-90deg" : "90deg" }] }}
        >
          <Icon name="chevron" size={size.check} tint={colors.muted} />
        </View>
      </View>
    );
  }
  /** A row of the list: lit while highlighted (the keys or the pointer), bolder with a check while chosen. */
  function Option(props: { item: SelectItemState; note?: string }) {
    return (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          height: pointer ? 32 : 46,
          paddingHorizontal: 8,
          borderRadius: 7,
          borderWidth: 1,
          borderColor: props.item.highlighted ? alpha(colors.accent, 0.3) : "transparent",
          backgroundColor: props.item.highlighted ? tints.accent : "transparent",
          opacity: props.item.disabled ? 0.35 : 1,
        }}
      >
        <Text style={{ numberOfLines: 1, flex: 1, fontSize: 14, fontWeight: props.item.selected ? "600" : "400", color: colors.text }}>
          {props.item.title}
        </Text>
        <If when={props.note}>
          <Text style={{ fontSize: 12, color: colors.faint }}>{props.note}</Text>
        </If>
        <View style={{ width: 16, alignItems: "center" }}>
          <If when={props.item.selected}>
            <Icon name="check" size={14} tint={colors.accent} />
          </If>
        </View>
      </View>
    );
  }
  function Header(props: { group: SelectGroup }) {
    return (
      <Text style={{ fontSize: 11, fontWeight: "600", letterSpacing: 0.6, color: colors.faint, paddingHorizontal: 9, paddingTop: 8, paddingBottom: 4 }}>
        {props.group.title.toUpperCase()}
      </Text>
    );
  }
  const opened = (set: (open: boolean) => void) => ({ open }: { open: boolean }) => set(open);

  function Choices() {
    const sort = signal<string | null>("newest");
    const font = signal<string | null>("inter");
    const sortOpen = signal(false);
    const fontOpen = signal(false);
    return (
      <Card icon="controls" title="Select" subtitle="A choice from a list: the app owns the value">
        <View>
          <View style={row(true)}>
            <Label label="Sort by" detail={pointer ? "Press a letter to jump to an order" : "Five orders in a sheet"} />
            <Select
              items={SORTS}
              value={sort()}
              onChange={({ value: next }) => {
                sort.set(next);
                last.set(`Sort by: ${titleOf(SORTS, next)}`);
              }}
              onOpenChange={opened((open) => sortOpen.set(open))}
              accessibilityLabel="Sort by"
              offset={4}
              margin={8}
              align="end"
              // Wider than the trigger with a pointer: the titles whole.
              popupStyle={pointer ? { ...surface(), width: 200 } : surface()}
              backdropStyle={backdrop}
              itemClass="active:opacity-70"
              trigger={<Picker title={titleOf(SORTS, sort())} open={sortOpen()} />}
              renderItem={(item) => <Option item={item} />}
            />
          </View>
          <View style={row(false)}>
            <Label label="Font" detail="Search, sections, one not installed" />
            <Select
              items={FONTS}
              value={font()}
              onChange={({ value: next }) => {
                font.set(next);
                last.set(next === null ? "Font: cleared" : `Font: ${titleOf(FONTS, next)}`);
              }}
              onOpenChange={opened((open) => fontOpen.set(open))}
              accessibilityLabel="Font"
              searchable
              searchPlaceholder="Search fonts"
              searchClass={`${pointer ? "text-sm" : "text-base"} text-foreground placeholder:text-faint`}
              searchStyle={{
                height: pointer ? 32 : 40,
                paddingHorizontal: 9,
                marginBottom: 6,
                borderRadius: radius.control,
                borderWidth: 1,
                borderColor: colors.fieldBorder,
                backgroundColor: colors.field,
                ...finish.field,
              }}
              empty={<Text style={{ paddingVertical: 20, textAlign: "center", fontSize: 14, color: colors.muted }}>No font matches</Text>}
              offset={4}
              margin={8}
              align="end"
              popupStyle={pointer ? { ...surface(), width: 260 } : surface()}
              backdropStyle={backdrop}
              itemClass="active:opacity-70"
              cleanable
              clearButtonAccessibilityLabel="Clear the font"
              clearButtonClass="items-center justify-center rounded-full enabled:hover:bg-accent active:bg-track"
              clearButtonStyle={{ position: "absolute", top: (size.line - size.clear) / 2, right: clearInset, width: size.clear, height: size.clear }}
              clearButton={<Icon name="close" size={size.clear - 6} tint={colors.muted} />}
              trigger={<Picker title={font() === null ? "Default" : titleOf(FONTS, font())} open={fontOpen()} placeholder={font() === null} clearable={font() !== null} />}
              renderItem={(item) => <Option item={item} note={item.disabled ? "Not installed" : undefined} />}
              renderGroup={(group) => <Header group={group} />}
            />
          </View>
          <View style={row(false)}>
            <Label label="Language" detail="Set by your organization" />
            <Select items={LANGUAGES} value="en" disabled accessibilityLabel="Language" trigger={<Picker title="English" open={false} disabled />} />
          </View>
        </View>
      </Card>
    );
  }

  function Tags() {
    const topics = signal<string[]>(["layout", "ios"]);
    const reviewer = signal<string[]>([]);
    const topicsOpen = signal(false);
    const reviewerOpen = signal(false);
    const names = (items: { value: string; title: string }[], values: string[]) => values.map((v) => titleOf(items, v));
    const topicsTitle = () => {
      const all = names(TOPICS, topics());
      return all.length <= 2 ? all.join(", ") : `${all.length} topics`;
    };
    return (
      <Card icon="controls" title="Combobox" subtitle="Several values from a list: the app owns them">
        <View>
          <View style={row(true)}>
            <Label label="Topics" detail="Several at once, with search; the list stays open" />
            <Combobox
              items={TOPICS}
              multiple
              value={topics()}
              onChange={({ value }) => {
                topics.set(value);
                last.set(`Topics: ${names(TOPICS, value).join(", ") || "none"}`);
              }}
              onConfirm={({ value }) => last.set(`Topics confirmed: ${value.length}`)}
              onOpenChange={opened((open) => topicsOpen.set(open))}
              accessibilityLabel="Topics"
              searchable
              searchPlaceholder="Search topics"
              searchClass={`${pointer ? "text-sm" : "text-base"} text-foreground placeholder:text-faint`}
              searchStyle={{
                height: pointer ? 32 : 40,
                paddingHorizontal: 9,
                marginBottom: 6,
                borderRadius: radius.control,
                borderWidth: 1,
                borderColor: colors.fieldBorder,
                backgroundColor: colors.field,
                ...finish.field,
              }}
              empty={<Text style={{ paddingVertical: 20, textAlign: "center", fontSize: 14, color: colors.muted }}>No topic matches</Text>}
              offset={4}
              margin={8}
              align="end"
              popupStyle={pointer ? { ...surface(), width: 240 } : surface()}
              backdropStyle={backdrop}
              itemClass="active:opacity-70"
              cleanable
              clearButtonAccessibilityLabel="Clear the topics"
              clearButtonClass="items-center justify-center rounded-full enabled:hover:bg-accent active:bg-track"
              clearButtonStyle={{ position: "absolute", top: (size.line - size.clear) / 2, right: clearInset, width: size.clear, height: size.clear }}
              clearButton={<Icon name="close" size={size.clear - 6} tint={colors.muted} />}
              footerStyle={{ marginTop: 6, paddingTop: 6, paddingHorizontal: 9, borderTopWidth: 1, borderColor: colors.border }}
              footer={<Text style={{ fontSize: 12, color: colors.muted }}>{`${topics().length} selected`}</Text>}
              trigger={<Picker title={topics().length ? topicsTitle() : "Add topics"} open={topicsOpen()} placeholder={!topics().length} clearable={topics().length > 0} />}
              renderItem={(item) => <Option item={item} note={item.disabled ? "Archived" : undefined} />}
              renderGroup={(group) => <Header group={group} />}
            />
          </View>
          <View style={row(false)}>
            <Label label="Reviewer" detail="One person: a choice replaces the last" />
            <Combobox
              items={REVIEWERS}
              value={reviewer()}
              onChange={({ value }) => {
                reviewer.set(value);
                last.set(`Reviewer: ${names(REVIEWERS, value)[0] ?? "none"}`);
              }}
              onOpenChange={opened((open) => reviewerOpen.set(open))}
              accessibilityLabel="Reviewer"
              offset={4}
              margin={8}
              align="end"
              popupStyle={pointer ? { ...surface(), width: 200 } : surface()}
              backdropStyle={backdrop}
              itemClass="active:opacity-70"
              trigger={<Picker title={names(REVIEWERS, reviewer())[0] ?? "Nobody"} open={reviewerOpen()} placeholder={!reviewer().length} />}
              renderItem={(item) => <Option item={item} />}
            />
          </View>
        </View>
      </Card>
    );
  }

  function Disclosure() {
    const storage = signal(false);
    const advanced = signal(false);
    const originals = signal(false);
    const look = switchLook(() => originals(), size.switch);
    /** The always-visible row that flips a section: the app's trigger, which tells screen readers whether it is expanded. */
    function Summary(props: { label: string; detail: string; open: boolean; set: (open: boolean) => void; first?: boolean }) {
      return (
        <View
          role="button"
          accessibilityState={{ expanded: props.open }}
          onPress={() => {
            const next = !props.open;
            props.set(next);
            last.set(`${props.label}: ${next ? "expanded" : "collapsed"}`);
          }}
          style={hoverRow(!!props.first)}
          activeStyle={pressed}
          hoverStyle={hovered()}
          focusStyle={focusRing()}
        >
          <Divider show={!props.first} />
          <Label label={props.label} detail={props.detail} />
          {/* A lane as wide as the chevron's stroke (half its icon box), so the chevron ends where the values below it end. */}
          <View
            class="transition-transform duration-150 motion-reduce:transition-none"
            style={{ width: size.check / 2, alignItems: "center", rotate: props.open ? "90deg" : "0deg" }}
          >
            <Icon name="chevron" size={size.check} tint={colors.muted} />
          </View>
        </View>
      );
    }
    return (
      <Card icon="controls" title="Collapsible" subtitle="Details under a summary, kept while collapsed">
        <View>
          <Collapsible
            open={storage()}
            content={
              <View style={{ paddingStart: size.gap, paddingBottom: size.padding }}>
                <Each of={USAGE}>
                  {(u) => (
                    <View style={{ flexDirection: "row", alignItems: "center", minHeight: size.line }}>
                      <Text style={{ flex: 1, fontSize: size.label, color: colors.muted }}>{u()[0]}</Text>
                      <Text style={{ fontSize: size.label, color: colors.muted, fontVariant: ["tabular-nums"] }}>{u()[1]}</Text>
                    </View>
                  )}
                </Each>
              </View>
            }
          >
            <Summary first label="Storage" detail="212 GB of 256 GB used" open={storage()} set={(open) => storage.set(open)} />
          </Collapsible>
          <Collapsible
            open={advanced()}
            content={
              <Switch
                checked={originals()}
                onChange={({ checked: on }) => {
                  originals.set(on);
                  last.set(`Keep originals: ${on ? "on" : "off"}`);
                }}
                style={{ ...hoverRow(false, size.gap), flexDirection: "row-reverse" }}
                activeStyle={pressed}
                hoverStyle={hovered()}
                focusStyle={focusRing()}
                trackStyle={look.trackStyle}
                thumbStyle={look.thumbStyle}
              >
                <Divider show />
                <Label label="Keep originals" detail={originals() ? "Edits are saved as copies" : "Edits replace the photo"} />
              </Switch>
            }
          >
            <Summary label="Advanced" detail="Options most people leave alone" open={advanced()} set={(open) => advanced.set(open)} />
          </Collapsible>
        </View>
      </Card>
    );
  }

  function Transfers() {
    const sent = signal(0);
    const running = signal(false);
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      running.set(false);
    };
    cleanup(stop);
    // The indeterminate bar's sweep: the app flips its translation, a
    // transition moves it; it rests in the middle with reduced motion.
    const end = signal(false);
    const sweep = setInterval(() => {
      if (!reduceMotion()) end.set(!end());
    }, 800);
    cleanup(() => clearInterval(sweep));
    const start = () => {
      if (sent() >= 100) sent.set(0);
      running.set(true);
      last.set("Upload: started");
      timer = setInterval(() => {
        sent.set(Math.min(100, sent() + 10));
        if (sent() >= 100) {
          stop();
          last.set("Upload: done");
        }
      }, 300);
    };
    /** A transfer: its label and value over a bar, the value tabular at the trailing edge. */
    function Transfer(props: { label: string; detail: string; value: number; indeterminate?: boolean; first?: boolean }) {
      return (
        <Progress
          value={props.value}
          indeterminate={props.indeterminate}
          // The label row first: the children follow the track.
          style={{ ...row(!!props.first), flexDirection: "column-reverse", alignItems: "stretch", gap: size.padding }}
          // The slider's rail and fill, so a level and a transfer read alike.
          trackStyle={{ height: 6, borderRadius: 3, overflow: "hidden", backgroundColor: colors.track, boxShadow: `inset 0 0 0 1px ${finish.track.borderColor}, ${finish.track.boxShadow}` }}
          indicatorClass={
            !props.indeterminate
              ? undefined
              : reduceMotion()
                ? "w-1/3 translate-x-full"
                : `w-1/3 transition-transform duration-700 ease-in-out ${end() ? "translate-x-[200%]" : "translate-x-0"}`
          }
          indicatorStyle={{ height: 6, borderRadius: 3, ...sliderFill(0, 1) }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: size.gap }}>
            <Label label={props.label} detail={props.detail} />
            <Text style={{ fontSize: size.label, color: colors.muted, fontVariant: ["tabular-nums"], textAlign: "right" }}>
              {props.indeterminate ? "—" : `${props.value}%`}
            </Text>
          </View>
        </Progress>
      );
    }
    return (
      <Card icon="controls" title="Progress" subtitle="Transfers: the app owns the value">
        <View>
          <Transfer
            first
            label="Upload"
            detail={sent() >= 100 ? "24 photos sent" : running() ? "Sending 24 photos" : "24 photos to send"}
            value={sent()}
          />
          <Transfer label="Backup" detail="Preparing: its size is not known yet" value={0} indeterminate />
        </View>
        {/* As wide as their labels with a pointer; sharing the row on a touch screen. */}
        <View style={{ flexDirection: "row", gap: size.gap, marginTop: size.padding, alignSelf: pointer ? "flex-start" : "stretch" }}>
          <Button
            label={running() ? "Pause" : sent() >= 100 ? "Send again" : "Send"}
            size={size.switch}
            flex={pointer ? undefined : 1}
            onPress={() => {
              if (running()) {
                stop();
                last.set("Upload: paused");
              } else start();
            }}
          />
          <Button
            label="Reset"
            variant="secondary"
            size={size.switch}
            flex={pointer ? undefined : 1}
            disabled={sent() === 0}
            onPress={() => {
              stop();
              sent.set(0);
              last.set("Upload: reset");
            }}
          />
        </View>
      </Card>
    );
  }

  function Levels() {
    const volume = signal(60);
    const price = signal<[number, number]>([100, 400]);
    const muted = signal(false);
    // The shared slider look (`sliderLook` and `sliderFill`, BJORK UI's
    // slider in the gallery's tones): an 8-point rail, a fill fading into a
    // 16 × 8 pill thumb, the value in a column after the rail; muted, it
    // fades to 35%. The spread holds only what never changes: a signal read
    // in it would make the slider again as it changes, mid-drag.
    /** A level: its label over the slider. */
    function Level(props: { label: string; detail: string; value?: string; first?: boolean; children: JSX.Element }) {
      return (
        <View style={{ ...row(!!props.first), flexDirection: "column", alignItems: "stretch", gap: size.padding }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: size.gap }}>
            <Label label={props.label} detail={props.detail} />
            <If when={props.value}>
              <Text style={{ fontSize: size.label, color: colors.muted, fontVariant: ["tabular-nums"], textAlign: "right" }}>{props.value}</Text>
            </If>
          </View>
          {props.children}
        </View>
      );
    }
    return (
      <Card icon="controls" title="Slider" subtitle="Levels and a range: the app owns the value">
        <View>
          <Level first label="Volume" detail={muted() ? "Muted" : "Media and alerts"}>
            <Slider
              value={volume()}
              step={5}
              accessibilityLabel="Volume"
              onChange={({ value }) => volume.set(value as number)}
              onChangeEnd={({ value }) => last.set(`Volume: ${value}`)}
              disabled={muted()}
              rangeStyle={sliderFill(0, volume() / 100)}
              {...sliderLook({ value: true })}
            >
              <Text class={sliderValueClass} style={sliderValueStyle()}>{muted() ? "—" : `${volume()}%`}</Text>
            </Slider>
          </Level>
          <Level label="Price" detail="Listings between the two" value={`$${price()[0]} – $${price()[1]}`}>
            <Slider
              value={price()}
              min={0}
              max={500}
              step={10}
              startAccessibilityLabel="Minimum price"
              accessibilityLabel="Maximum price"
              onChange={({ value }) => price.set(value as [number, number])}
              onChangeEnd={({ value }) => last.set(`Price: ${(value as [number, number]).join(" to ")}`)}
              rangeStyle={sliderFill(price()[0] / 500, price()[1] / 500)}
              {...sliderLook()}
            />
          </Level>
        </View>
        <View style={{ flexDirection: "row", gap: size.gap, marginTop: size.padding, alignSelf: pointer ? "flex-start" : "stretch" }}>
          <Button
            label={muted() ? "Unmute" : "Mute"}
            variant="secondary"
            size={size.switch}
            flex={pointer ? undefined : 1}
            onPress={() => {
              muted.set(!muted());
              last.set(muted() ? "Volume: muted" : "Volume: unmuted");
            }}
          />
        </View>
      </Card>
    );
  }

  function Quantities() {
    const seats = signal<number | null>(2);
    const price = signal<number | null>(24.5);
    const locked = signal(false);
    // One recessed well per input: a stronger border under the pointer and
    // the keyboard's focus ring while its field edits (`focus-within:`);
    // the buttons light up under the pointer and while pressed (still with
    // reduced motion) and fade where a step does nothing (at the minimum
    // or maximum) or while the input is locked, without their hover.
    const frame = [
      pointer ? "h-8 rounded-md" : "h-11 rounded-lg",
      "flex-row items-stretch overflow-hidden border border-input bg-field",
      "enabled:hover:border-faint focus-within:outline-2 focus-within:outline-info",
    ].join(" ");
    const press = "items-center justify-center transition-colors duration-100 motion-reduce:transition-none enabled:hover:bg-accent active:bg-track disabled:opacity-35";
    const field = () => ({
      flex: 1,
      minWidth: 0,
      paddingHorizontal: 8,
      fontSize: size.label,
      color: colors.text,
      placeholderColor: colors.faint,
      fontVariant: ["tabular-nums" as const],
    });
    /** A step button's glyph: the gallery's icon, in the muted text color. */
    function Step(props: { name: "plus" | "minus" | "chevron-up" | "chevron-down"; size: number }) {
      return <Icon name={props.name} size={props.size} tint={colors.muted} />;
    }
    /** A quantity: its label and the input at the trailing edge. */
    function Amount(props: { label: string; detail: string; first?: boolean; children: JSX.Element }) {
      return (
        <View style={row(!!props.first)}>
          <Label label={props.label} detail={props.detail} />
          <View style={{ width: pointer ? 132 : 152 }}>{props.children}</View>
        </View>
      );
    }
    const show = (v: number | null) => (v === null ? "none" : `${v}`);
    return (
      <Card icon="controls" title="Number input" subtitle="Typed or stepped: the app owns the value">
        <View>
          <Amount first label="Seats" detail="1 to 8 per booking">
            <NumberInput
              value={seats()}
              min={1}
              max={8}
              disabled={locked()}
              accessibilityLabel="Seats"
              onChange={({ value: next }) => {
                seats.set(next);
                last.set(`Seats: ${show(next)}`);
              }}
              class={`${frame} disabled:opacity-50`}
              inputStyle={{ ...field(), textAlign: "center" }}
              decrementButtonClass={`${pointer ? "w-8" : "w-11"} ${press} border-r border-line`}
              incrementButtonClass={`${pointer ? "w-8" : "w-11"} ${press} border-l border-line`}
              decrementButton={<Step name="minus" size={pointer ? 14 : 16} />}
              incrementButton={<Step name="plus" size={pointer ? 14 : 16} />}
            />
          </Amount>
          <Amount label="Price" detail="Steps of 0.5">
            <NumberInput
              value={price()}
              min={0}
              step={0.5}
              placeholder="Free"
              accessibilityLabel="Price"
              controlsRight
              onChange={({ value: next }) => {
                price.set(next);
                last.set(`Price: ${show(next)}`);
              }}
              class={frame}
              inputStyle={{ ...field(), paddingLeft: 4 }}
              controlsClass={`${pointer ? "w-6" : "w-9"} border-l border-line`}
              incrementButtonClass={`flex-1 ${press} border-b border-line`}
              decrementButtonClass={`flex-1 ${press}`}
              incrementButton={<Step name="chevron-up" size={pointer ? 12 : 14} />}
              decrementButton={<Step name="chevron-down" size={pointer ? 12 : 14} />}
              prefix={
                <View style={{ height: "100%", justifyContent: "center", paddingLeft: 10 }}>
                  <Text style={{ fontSize: size.label, color: colors.muted, transform: [{ translateY: -1 }] }}>$</Text>
                </View>
              }
            />
          </Amount>
        </View>
        <View style={{ flexDirection: "row", gap: size.gap, marginTop: size.padding, alignSelf: pointer ? "flex-start" : "stretch" }}>
          <Button
            label={locked() ? "Unlock seats" : "Lock seats"}
            variant="secondary"
            size={size.switch}
            flex={pointer ? undefined : 1}
            onPress={() => {
              locked.set(!locked());
              last.set(locked() ? "Seats: locked" : "Seats: unlocked");
            }}
          />
        </View>
      </Card>
    );
  }

  function Verify() {
    const CODE = "246810";
    const code = signal("");
    const verdict = signal("");
    // The cell that takes the next digit shows the focus ring while the
    // code has the focus; the caret blinks there (steady with reduced
    // motion: the input's own).
    const cell = pointer ? "w-9 h-11 text-lg" : "w-11 h-13 text-xl";
    return (
      <Card icon="controls" title="One-time code" subtitle="Six digits: type or paste them">
        <View style={{ alignItems: "center", gap: size.gap, paddingVertical: size.padding }}>
          <OtpInput
            length={6}
            groups={2}
            value={code()}
            onChange={({ value: next }) => {
              code.set(next);
              verdict.set("");
              last.set(`Code: ${next || "empty"}`);
            }}
            onComplete={({ value }) => {
              verdict.set(value === CODE ? "Verified" : "That code is not right");
              last.set(`Code complete: ${value}`);
            }}
            accessibilityLabel="Verification code, 6 digits"
            class="flex-row items-center gap-3"
            groupClass="flex-row gap-1.5"
            cellClass={`${cell} items-center justify-center rounded-lg font-semibold text-foreground transition-colors motion-reduce:transition-none focus:outline-2 focus:outline-info focus:-outline-offset-2`}
            cellStyle={{ ...finish.inset, backgroundColor: colors.inset, borderWidth: 1, borderColor: colors.line }}
            caretClass="w-0.5 h-6 rounded-full"
            caretStyle={{ backgroundColor: colors.text }}
          />
          <Text style={{ fontSize: size.detail, color: verdict() === "Verified" ? toneColor("up") : verdict() ? toneColor("down") : colors.muted }}>
            {verdict() || `The code is ${CODE}`}
          </Text>
          <Button
            label="Clear"
            variant="secondary"
            size={size.switch}
            disabled={code() === ""}
            onPress={() => {
              code.set("");
              verdict.set("");
              last.set("Code: cleared");
            }}
          />
        </View>
      </Card>
    );
  }

  function Last() {
    return (
      <Card icon="system" title="Last event">
        <Text style={{ fontSize: 13, color: colors.text, fontFamily: mono }}>{last()}</Text>
      </Card>
    );
  }

  const cards = { Switch: Settings, Checkbox: Filter, Radio: Plans, Tabs: Sections, Select: Choices, Combobox: Tags, Collapsible: Disclosure, Progress: Transfers, Slider: Levels, NumberInput: Quantities, OtpInput: Verify };
  return <DemoPage cards={[cards[props.show], Last]} />;
}

export const SwitchDemo = () => <Controls show="Switch" />;
export const CheckboxDemo = () => <Controls show="Checkbox" />;
export const RadioDemo = () => <Controls show="Radio" />;
export const TabsDemo = () => <Controls show="Tabs" />;
export const SelectDemo = () => <Controls show="Select" />;
export const ComboboxDemo = () => <Controls show="Combobox" />;
export const CollapsibleDemo = () => <Controls show="Collapsible" />;
export const ProgressDemo = () => <Controls show="Progress" />;
export const SliderDemo = () => <Controls show="Slider" />;
export const NumberInputDemo = () => <Controls show="NumberInput" />;
export const OtpInputDemo = () => <Controls show="OtpInput" />;
