import { cleanup, computed, signal, Text, View } from "nsh";
import { Checkbox, Collapsible, Progress, Radio, RadioGroup, Switch, Tab, Tabs } from "nsh/base";
import { reduceMotion } from "nsh";
import { platform } from "nsh";
import { Icon } from "../icons";
import { Badge, Button, Caption, Card, colors, DemoPage, finish, focusRing, hovered, mono, switchLook, toneColor } from "../ui";

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
    ? { row: 40, padding: 6, gap: 10, label: 14, detail: 12, control: 16, corner: 5, check: 12, dash: 8, dot: 6, tabs: 30, line: 32, switch: "small" as const }
    : { row: 56, padding: 8, gap: 12, label: 15, detail: 13, control: 22, corner: 7, check: 16, dash: 10, dot: 8, tabs: 40, line: 44, switch: "regular" as const };
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

/** The fill of a box or ring that is on, and of one that is off. */
const fill = (on: boolean) =>
  on
    ? { backgroundColor: colors.accentFill, borderColor: colors.accentFill, boxShadow: finish.chip.boxShadow }
    : { backgroundColor: colors.field, borderColor: colors.fieldBorder, boxShadow: finish.field.boxShadow };

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

/** What a checkbox's box shows. */
function BoxMark(props: { mark: Mark }) {
  return (
    <>
      <If when={props.mark === "check"}>
        <Icon name="check" size={size.check} tint={colors.onAccent} />
      </If>
      <If when={props.mark === "dash"}>
        <View style={{ width: size.dash, height: 2, borderRadius: 1, backgroundColor: colors.onAccent }} />
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

/**
 * Controls: `nsh/base`'s `Switch`, `Checkbox`, `Radio` and `RadioGroup`,
 * `Tab` and `Tabs`, `Collapsible` in the settings, filters, pickers, section
 * switchers and disclosures apps use them for.
 */
export function Controls() {
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
          onChange={(on) => {
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
            onChange={(on) => {
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
                onChange={(on) => {
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
                <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: "500", color: section() === s().name ? colors.text : colors.muted }}>
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
            style={{ width: size.check / 2, alignItems: "center", transform: [{ rotate: props.open ? "90deg" : "0deg" }] }}
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
                onChange={(on) => {
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
          trackStyle={{ height: 6, borderRadius: 3, overflow: "hidden", backgroundColor: colors.raised }}
          indicatorClass={
            !props.indeterminate
              ? undefined
              : reduceMotion()
                ? "w-1/3 translate-x-full"
                : `w-1/3 transition-transform duration-700 ease-in-out ${end() ? "translate-x-[200%]" : "translate-x-0"}`
          }
          indicatorStyle={{ height: 6, borderRadius: 3, backgroundColor: toneColor("accent") }}
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

  function Last() {
    return (
      <Card icon="system" title="Last event">
        <Text style={{ fontSize: 13, color: colors.text, fontFamily: mono }}>{last()}</Text>
      </Card>
    );
  }

  return <DemoPage cards={[Settings, Filter, Plans, Sections, Disclosure, Transfers, Last]} />;
}
