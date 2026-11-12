import { type AnimatedValue, cleanup, computed, createAnimatedValue, createMotion, effect, type JSX, LayoutAnimation, Scroll, signal, Text, token, View } from "nsh";
import { Button as BaseButton, Checkbox, Collapsible, Combobox, type DateMatcher, DatePicker, type DateRangePreset, NumberInput, OtpInput, type OtpInputRef, Progress, Radio, RadioGroup, Select, Slider, Switch, Tab, Tabs } from "nsh/base";
import { reduceMotion } from "nsh";
import { platform, windowSize } from "nsh";
import { Icon, type IconName } from "../icons";
import { alpha, backdrop, Badge, Button, CalendarItem, Kbd, calendarLook, Chevron, Caption, Card, chart, checkboxLook, DateTrigger, CheckboxMark, density, type CheckboxMarkKind, ChoiceLight, choiceTileLook, choiceWell, clearButtonLook, colors, comboboxLook, ComboToggle, controlSize, DemoPage, finish, focusRing, follow, hovered, IconTile, insetSurface, labelColumn, ListboxEmpty, ListboxHeader, listboxPopup, listboxSearch, listRow, MARK_WEIGHT, mono, motion, numberInputClasses, numberInputSteps, numberInputText, optionClass, OptionRow, otpCellLook, otpCells, Picker, plainRow, RadioRing, radius, RowDivider, RowLabel, Segmented, sliderFill, solidTint, sliderLook, switchLook, TAB_ICON_ROOM, tabsLook, TabTitle, terminal, TERMINAL_COLUMN, TERMINAL_GAP, TERMINAL_ROW, timeFieldClass, TimeSegment, tints, type Tone, toneColor, toneTint, underlineTabsLook, DisclosureChevron, disclosureTriggerLook, progressLook, progressSweep, LastEvent } from "../ui";
import { play as sound } from "../../nsh-gallery-ui/sound";

// `nsh/base`'s controls own presses, keys, the disabled state and what
// screen readers say; every value is the app's, and so is the look: the
// gallery's own here, with its hover and keyboard focus ring (`hovered`,
// `focusRing`) on every control. So is the motion, gpui-kit's: marks and
// fills come and go with `motion.control`'s spring, thumbs and indicators
// travel with `motion.move`'s (`follow`), and land at once with reduced
// motion.

/**
 * The sizes of the page (`controlSize`): touch screens take the standard
 * tier (44 pt and more to press); a pointer the compact one desktops'
 * settings and filters use: smaller controls, rows and type, whatever the
 * window's width.
 */
const size = controlSize;
const pointer = platform.desktop;

/** A row of values or of a field (`plainRow`): no presses, a hairline above all but the first; a `wide` control (a combobox) goes under its label on a touch screen. */
const row = (first: boolean, wide = false) => plainRow({ first, wide });

const pressed = { opacity: 0.7 };
const dimmed = { opacity: 0.5 };

/** A layer over the whole of its parent, its content centered: layers that cross over in place. */
const centered = { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" } as const;

/**
 * The top of a control `height` tall in a choice tile's corner, centered on the line `center` points below the tile's
 * padding edge (the tile's own padding is 14 on top: `choiceTileLook`), so it sits level with the icon or title it
 * goes with; the terminal keeps `cells`.
 */
const cornerTop = (center: number, height: number, cells: number) => (terminal ? cells : Math.round(center - height / 2));
/** A small box's or ring's size, as `checkboxLook({ scale: 0.8 })` and `RadioRing scale={0.8}` draw it. */
const smallChoice = Math.round(size.control * 0.8);

type Mark = CheckboxMarkKind;

/**
 * An animated value that runs from 0 to 1 on `motion.control`'s spring each
 * time `key` changes: content swapped in (a tab's, an opened section's)
 * settles into place rather than appearing. At rest at once with reduced
 * motion.
 */
function settleOn(key: () => unknown): AnimatedValue {
  const t = createAnimatedValue(1);
  let shown = key();
  effect(() => {
    const next = key();
    if (next === shown) return;
    shown = next;
    if (reduceMotion()) return;
    t.set(0);
    t.spring(1, motion.control);
  });
  return t;
}

/**
 * A scale at rest at 1 that bounces a little past it each time `key`
 * changes (`motion.move`'s spring with a kick, about 7% at its peak), so
 * what changed pops; still with reduced motion.
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

/** Content that settles in with `t` (`settleOn`): it fades in and drops a few points into place. */
const settle = (t: AnimatedValue) => ({ opacity: t, transform: [{ translateY: t.interpolate({ inputRange: [0, 1], outputRange: [-6, 0] }) }] });

/**
 * Animates the next commit's layout natively: rows that move to their new
 * places (a list sorted again), chips that come and go and the ones after
 * them closing up. Everything lands at once with reduced motion.
 */
function animateLayout() {
  if (!reduceMotion()) LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
}

/**
 * A figure that rolls to each new value: the new one comes in from below as
 * it grows and from above as it shrinks, fading in on `motion.control`'s
 * spring, clipped to its line; in place with reduced motion.
 */
function Ticker(props: { value: number; text: string; size?: number; weight?: "400" | "500" | "600"; color?: string }) {
  const y = createAnimatedValue(0);
  const shown = createAnimatedValue(1);
  let at = props.value;
  effect(() => {
    const next = props.value;
    if (next === at) return;
    const up = next > at;
    at = next;
    if (reduceMotion()) return;
    y.set(up ? 10 : -10);
    shown.set(0);
    y.spring(0, motion.control);
    shown.spring(1, motion.control);
  });
  return (
    <View style={{ overflow: "hidden" }}>
      <View style={{ opacity: shown, transform: [{ translateY: y }] }}>
        <Text style={{ fontSize: props.size ?? size.label, fontWeight: props.weight ?? "500", color: props.color ?? colors.text, fontVariant: ["tabular-nums"], textAlign: "right" }}>
          {props.text}
        </Text>
      </View>
    </View>
  );
}

/** A status's dot: its color crosses over to a new status's. */
function Dot(props: { color: string; size?: number }) {
  const d = props.size ?? 8;
  return (
    <View
      style={{ width: d, height: d, borderRadius: d / 2, backgroundColor: props.color, transitionProperty: "background-color", transitionDuration: reduceMotion() ? 0 : 150 }}
    />
  );
}

/** A person's initials on their tone's tint, edged in it; the tint is opaque
 * on `on`, the color of what the face sits on (default the card), so faces
 * that overlap hide each other, and a `ring` (in a stack) is that color too. */
function Avatar(props: { name: string; tone: Tone; size?: number; ring?: boolean; on?: string }) {
  const d = props.size ?? 22;
  return (
    <View
      style={{
        width: d,
        height: d,
        borderRadius: d / 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: solidTint(props.tone, props.on ?? colors.surface),
        borderWidth: props.ring ? 2 : 1,
        // In a stack, a ring of the color under the faces parts them.
        borderColor: props.ring ? (props.on ?? colors.surface) : alpha(props.tone === "neutral" ? colors.text : toneColor(props.tone), 0.25),
      }}
    >
      <Text style={{ fontSize: Math.round(d * 0.42), fontWeight: "600", color: props.tone === "neutral" ? colors.muted : toneColor(props.tone) }}>{initials(props.name)}</Text>
    </View>
  );
}

/**
 * A value as a chip that pops in as it is added (a motion, which lands at
 * once with reduced motion), with a button that removes it. `lead` goes
 * before the label: an avatar, a dot.
 */
function Chip(props: { label: string; lead: JSX.Element; remove: string; onRemove: () => void }) {
  const m = createMotion({ enter: "popIn", duration: 320 });
  cleanup(() => m.stop());
  const h = pointer ? 26 : 32;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        height: terminal ? undefined : h,
        // The lead (a face, a dot) close to the start.
        paddingLeft: 3,
        paddingRight: 3,
        borderRadius: h / 2,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.raised,
        boxShadow: finish.chip.boxShadow,
        ...m.style,
      }}
    >
      {props.lead}
      <Text style={{ fontSize: pointer ? 12 : 14, color: colors.text }}>{props.label}</Text>
      <BaseButton
        accessibilityLabel={props.remove}
        onPress={props.onRemove}
        class="items-center justify-center rounded-full enabled:hover:bg-foreground/8 active:bg-track"
        // Nearly the chip's height under a finger; a terminal's is its mark, as text.
        style={terminal ? undefined : { width: pointer ? h - 8 : h - 4, height: pointer ? h - 8 : h - 4 }}
        focusVisibleStyle={focusRing()}
      >
        <If when={terminal} else={<Icon name="close" size={pointer ? 10 : 12} tint={colors.muted} />}>
          <Text style={{ color: colors.muted }}>×</Text>
        </If>
      </BaseButton>
    </View>
  );
}

// A bar's rail and fill, the fill gliding to each value, and the
// indeterminate sweep: `look/meter.ts`'s (`progressLook`).

/**
 * The widths of a row of tab titles without their icons (`TabTitle`'s
 * `onWidth`, `report(i)`), and the row's width (`room`, from its
 * `onLayout`): what a row decides on its icons by. `widths()` is empty until
 * every title has reported. The widths are kept as reported and notify once
 * all are in, then on each change: not once per report.
 */
function titles(count: number) {
  const bare: number[] = [];
  let reported = 0;
  const changed = signal(0);
  const room = signal(0);
  return {
    room,
    widths: () => (changed(), reported === count ? bare : []),
    report: (i: number) => (w: number) => {
      const was = bare[i];
      if (was !== undefined && Math.abs(was - w) < 0.5) return;
      if (was === undefined) reported++;
      bare[i] = w;
      if (reported === count) changed.set(changed() + 1);
    },
  };
}

/** The terminal's text for each step button's icon. */
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

const TASKS = ["Freeze the API", "Write the release notes", "Record the compatibility baseline", "Tag the release", "Announce it"];

const COOKIES: { name: string; detail: string; required?: boolean }[] = [
  { name: "Necessary", detail: "Signing in, security and your settings", required: true },
  { name: "Analytics", detail: "Which pages are visited, counted without who visited them" },
  { name: "Personalization", detail: "Remembers your region and the layout you chose" },
  { name: "Marketing", detail: "Shows our offers on other sites" },
];

const CHANNELS: { name: string; detail: string; icon: "bell" | "chat" | "document"; disabled?: boolean }[] = [
  { name: "Push", detail: "As it happens", icon: "bell" },
  { name: "Email", detail: "A daily digest", icon: "document" },
  { name: "SMS", detail: "Add a number first", icon: "chat", disabled: true },
];

const SIZES = [
  { name: "Small", scale: 0.8 },
  { name: "Regular", scale: 1 },
  { name: "Large", scale: 1.25 },
];

const SPEEDS: { name: string; detail: string; price: string; disabled?: boolean }[] = [
  { name: "Standard", detail: "In 3 to 5 days", price: "Included" },
  { name: "Express", detail: "Tomorrow", price: "$9" },
  { name: "Same day", detail: "Not in your area", price: "$19", disabled: true },
];

const TEXT_SIZES: { name: string; scale: number; text: number; disabled?: boolean }[] = [
  { name: "Small", scale: 0.8, text: 13 },
  { name: "Medium", scale: 1, text: 15 },
  { name: "Large", scale: 1.25, text: 18 },
  { name: "Huge", scale: 1.25, text: 22, disabled: true },
];

const SECTIONS: { name: string; icon: IconName; rows: [string, string][]; disabled?: boolean }[] = [
  {
    name: "Overview",
    icon: "chart",
    rows: [
      ["Visitors", "12,480"],
      ["Sign-ups", "342"],
      ["Conversion", "2.74%"],
    ],
  },
  {
    name: "Activity",
    icon: "bell",
    rows: [
      ["Deployed to production", "09:41"],
      ["Invoice paid", "08:15"],
      ["A member joined", "07:02"],
    ],
  },
  {
    name: "Members",
    icon: "chat",
    rows: [
      ["Ada Lovelace", "Owner"],
      ["Grace Hopper", "Admin"],
      ["Alan Turing", "Member"],
    ],
  },
  { name: "Billing", icon: "document", rows: [], disabled: true },
];

const PROJECT: { name: string; icon: "code" | "spark" | "diff" | "document"; count?: number; rows: [string, string][]; disabled?: boolean }[] = [
  {
    name: "Code",
    icon: "code",
    rows: [
      ["crates/", "2 hours ago"],
      ["examples/", "yesterday"],
      ["README.md", "last week"],
    ],
  },
  {
    name: "Issues",
    icon: "spark",
    count: 12,
    rows: [
      ["Text clips when the window shrinks", "#482"],
      ["A slower first frame on Android 12", "#476"],
      ["Support right-to-left menus", "#451"],
    ],
  },
  {
    name: "Pull requests",
    icon: "diff",
    count: 3,
    rows: [
      ["Animate the controls' state changes", "#601"],
      ["Sort the gallery's components", "#600"],
      ["Read fonts from the bundle", "#597"],
    ],
  },
  { name: "Wiki", icon: "document", rows: [], disabled: true },
];

const FAQ = [
  { q: "Can I change my plan later?", a: "Yes. A new plan starts at once, and what is left of the old one is credited to your next invoice." },
  { q: "What happens to my photos if I cancel?", a: "They stay yours: you can download them for 30 days, then the library is deleted for good." },
  { q: "Do you offer a discount for teams?", a: "Teams of ten or more pay 20% less per seat, billed once a year." },
];

const USAGE: [string, string][] = [
  ["Photos", "120 GB"],
  ["Apps", "54 GB"],
  ["System", "38 GB"],
];

const FILES: { name: string; size: string; icon: "photos" | "media" | "document"; pace: number }[] = [
  { name: "Lisbon, 48 photos", size: "212 MB", icon: "photos", pace: 9 },
  { name: "Interview.mov", size: "1.2 GB", icon: "media", pace: 4 },
  { name: "Contract.pdf", size: "2 MB", icon: "document", pace: 25 },
];

const STEPS = ["Account", "Profile", "Team", "Review"];

const METERS: { name: string; height: number; note: (v: number) => string }[] = [
  { name: "Battery", height: 4, note: (v) => (v < 20 ? `${v}%, charge soon` : `${v}%`) },
  { name: "Storage", height: 6, note: (v) => (v > 85 ? `${v}% used, almost full` : `${v}% used`) },
  { name: "Profile", height: 10, note: (v) => `${v}% complete` },
];

/** Listings per $25 of price, from $0 to $500. */
const HISTOGRAM = [3, 6, 11, 18, 26, 31, 34, 29, 24, 22, 19, 15, 12, 10, 8, 6, 5, 3, 2, 1];
const HISTOGRAM_MAX = Math.max(...HISTOGRAM);
/** Whether the histogram's bar `i` (its prices from `i` × 25 up to the next bar's) holds a price in the range, both ends
 * included: a range closed to one price lights the bar that price falls in. */
const inRange = (i: number, [from, to]: [number, number]) => (i + 1) * 25 > from && i * 25 <= to;
/** How many listings the price range holds (the bars it covers). */
const listings = (range: [number, number]) => HISTOGRAM.reduce((n, c, i) => (inRange(i, range) ? n + c : n), 0);

const BANDS = ["60", "250", "1k", "4k", "16k"];
const EQ_PRESETS = [
  { value: "Flat" as const, label: "Flat" },
  { value: "Bass" as const, label: "Bass" },
  { value: "Vocal" as const, label: "Vocal" },
];
const PRESETS = { Flat: [0, 0, 0, 0, 0], Bass: [8, 5, 0, -2, -1], Vocal: [-3, 0, 5, 4, 1] };

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

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

/** A day's ISO date (`"2026-10-28"`), in local time as the calendar's days are. */
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d: Date, days: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
/** An ISO date's month and day as a trigger shows them: `Oct 28`. */
const monthDay = (value: string) => `${MONTHS[Number(value.slice(5, 7)) - 1].slice(0, 3)} ${Number(value.slice(8, 10))}`;
/** An ISO date (and time) as a trigger shows it: `Oct 28, 2026`, `Oct 28, 2026 · 09:30`. */
const shortDate = (value: string) => `${monthDay(value)}, ${value.slice(0, 4)}${value.length > 10 ? ` · ${value.slice(11, 16)}` : ""}`;

const titleOf = (items: { value: string; title: string }[], value: string | null) => items.find((i) => i.value === value)?.title ?? "None";

const DOWNLOADS: { name: string; kind: string; mb: number; days: number; icon: IconName }[] = [
  { name: "Quarterly report.pdf", kind: "PDF", mb: 2.4, days: 3, icon: "document" },
  { name: "Lisbon, 48 photos", kind: "Folder", mb: 212, days: 1, icon: "photos" },
  { name: "Interview.mov", kind: "Movie", mb: 1240, days: 6, icon: "media" },
  { name: "Brand assets.zip", kind: "Archive", mb: 86, days: 12, icon: "layers" },
  { name: "Notes.md", kind: "Text", mb: 0.02, days: 0, icon: "text" },
];
type DownloadSort = "name" | "added" | "size" | "kind";
/** The orders of the downloads, and the way each runs first: names and kinds A to Z, the newest and largest first. */
const DOWNLOAD_SORTS: { value: DownloadSort; title: string; down: boolean }[] = [
  { value: "name", title: "Name", down: false },
  { value: "added", title: "Date added", down: true },
  { value: "size", title: "Size", down: true },
  { value: "kind", title: "Kind", down: false },
];
const fileSize = (mb: number) => (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : mb >= 1 ? `${Math.round(mb)} MB` : `${Math.round(mb * 1000)} KB`);
const ago = (days: number) => (days === 0 ? "Today" : days === 1 ? "Yesterday" : `${days} days ago`);

const COUNTRIES: { value: string; title: string; flag: string; dial: string; group: string; days: string; currency: string; disabled?: boolean }[] = [
  { value: "hk", title: "Hong Kong", flag: "🇭🇰", dial: "+852", group: "Asia", days: "1–2 days", currency: "HKD" },
  { value: "jp", title: "Japan", flag: "🇯🇵", dial: "+81", group: "Asia", days: "2–3 days", currency: "JPY" },
  { value: "sg", title: "Singapore", flag: "🇸🇬", dial: "+65", group: "Asia", days: "2–4 days", currency: "SGD" },
  { value: "kr", title: "South Korea", flag: "🇰🇷", dial: "+82", group: "Asia", days: "3–4 days", currency: "KRW" },
  { value: "fr", title: "France", flag: "🇫🇷", dial: "+33", group: "Europe", days: "4–6 days", currency: "EUR" },
  { value: "de", title: "Germany", flag: "🇩🇪", dial: "+49", group: "Europe", days: "4–6 days", currency: "EUR" },
  { value: "pt", title: "Portugal", flag: "🇵🇹", dial: "+351", group: "Europe", days: "5–7 days", currency: "EUR" },
  { value: "gb", title: "United Kingdom", flag: "🇬🇧", dial: "+44", group: "Europe", days: "4–5 days", currency: "GBP" },
  { value: "br", title: "Brazil", flag: "🇧🇷", dial: "+55", group: "Americas", days: "—", currency: "BRL", disabled: true },
  { value: "ca", title: "Canada", flag: "🇨🇦", dial: "+1", group: "Americas", days: "3–5 days", currency: "CAD" },
  { value: "mx", title: "Mexico", flag: "🇲🇽", dial: "+52", group: "Americas", days: "6–8 days", currency: "MXN" },
  { value: "us", title: "United States", flag: "🇺🇸", dial: "+1", group: "Americas", days: "3–5 days", currency: "USD" },
];
const COUNTRY_ITEMS = COUNTRIES.map(({ value, title, group, disabled }) => ({ value, title, group, disabled }));

/** An issue's states, each with its tone: a dot of that color marks it. */
const STATUSES: { value: string; title: string; tone: Tone | "faint" }[] = [
  { value: "backlog", title: "Backlog", tone: "faint" },
  { value: "todo", title: "To do", tone: "neutral" },
  { value: "progress", title: "In progress", tone: "warn" },
  { value: "review", title: "In review", tone: "info" },
  { value: "done", title: "Done", tone: "up" },
  { value: "canceled", title: "Canceled", tone: "danger" },
];
const STATUS_ITEMS = STATUSES.map(({ value, title }) => ({ value, title }));
const statusColor = (value: string | null) => {
  const tone = STATUSES.find((s) => s.value === value)?.tone ?? "faint";
  return tone === "faint" ? colors.faint : toneColor(tone);
};
const TEAMS = [
  { value: "design", title: "Design" },
  { value: "platform", title: "Platform" },
  { value: "mobile", title: "Mobile" },
  { value: "web", title: "Web" },
  { value: "docs", title: "Docs" },
];
const PRIORITIES = [
  { value: "urgent", title: "Urgent" },
  { value: "high", title: "High" },
  { value: "low", title: "Low" },
];

const PEOPLE: { value: string; title: string; role: string; tone: Tone; disabled?: boolean }[] = [
  { value: "ada", title: "Ada Lovelace", role: "Engineering", tone: "accent" },
  { value: "grace", title: "Grace Hopper", role: "Platform", tone: "info" },
  { value: "alan", title: "Alan Turing", role: "Research", tone: "warn" },
  { value: "katherine", title: "Katherine Johnson", role: "Design", tone: "up" },
  { value: "margaret", title: "Margaret Hamilton", role: "Mobile", tone: "danger" },
  { value: "linus", title: "Linus Torvalds", role: "Kernel", tone: "down" },
  { value: "dennis", title: "Dennis Ritchie", role: "Away until Monday", tone: "neutral", disabled: true },
];
/** The most people a task takes. */
const MAX_PEOPLE = 4;
const initials = (name: string) =>
  name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("");

const LABELS: { value: string; title: string; tone: Tone }[] = [
  { value: "bug", title: "bug", tone: "danger" },
  { value: "feature", title: "feature", tone: "up" },
  { value: "docs", title: "docs", tone: "info" },
  { value: "performance", title: "performance", tone: "warn" },
  { value: "good-first-issue", title: "good first issue", tone: "accent" },
];
/** The tones labels the user creates take, in turn. */
const NEW_TONES: Tone[] = ["accent", "info", "up", "warn", "down"];
/** The value of a label the user creates: unique, as a label of the same title is never created twice. */
const NEW_LABEL = "new:";

const COMMANDS: { value: string; title: string; group: string; icon: IconName; keys?: string; disabled?: boolean }[] = [
  { value: "new-file", title: "New file", group: "Suggestions", icon: "document", keys: "⌘N" },
  { value: "search", title: "Search everywhere", group: "Suggestions", icon: "search", keys: "⇧⌘F" },
  { value: "sidebar", title: "Toggle sidebar", group: "View", icon: "sidebar", keys: "⌘B" },
  { value: "terminal", title: "Toggle terminal", group: "View", icon: "terminal", keys: "⌃`" },
  { value: "zoom", title: "Reset zoom", group: "View", icon: "search", disabled: true },
  { value: "dark", title: "Use the dark theme", group: "Appearance", icon: "moon" },
  { value: "light", title: "Use the light theme", group: "Appearance", icon: "sun" },
];
const COMMAND_ITEMS = COMMANDS.map(({ value, title, group, disabled }) => ({ value, title, group, disabled }));

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** An ISO date's day, in local time. */
const dateOf = (value: string) => new Date(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));
/** An ISO date's day of the week, 0 Sunday. */
const weekday = (value: string) => dateOf(value).getDay();
/** An ISO date as a row of a booking shows it: `Thu, Oct 29`. */
const dayTitle = (value: string) => `${DAY_NAMES[weekday(value)]}, ${monthDay(value)}`;
/** The days from one ISO date to another. */
const daysBetween = (from: string, to: string) => {
  const day = (v: string) => Date.UTC(Number(v.slice(0, 4)), Number(v.slice(5, 7)) - 1, Number(v.slice(8, 10)));
  return Math.round((day(to) - day(from)) / 86_400_000);
};
/** A night's rate: Fridays and Saturdays cost more. */
const nightRate = (value: string) => (weekday(value) === 5 || weekday(value) === 6 ? 220 : 180);
const CLEANING = 40;
const SLOTS = ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "14:00", "15:30", "16:00"];
/** Whether the slot `i` of a day is booked already: a few a day, a different few each day. */
const slotTaken = (date: string, i: number) => (Number(date.slice(8, 10)) + i * 3) % 5 === 0;

const CART: { name: string; detail: string; price: number; stock: number; icon: IconName }[] = [
  { name: "Linen shirt", detail: "Sand, M", price: 48, stock: 10, icon: "styles" },
  { name: "Canvas tote", detail: "Natural", price: 22, stock: 3, icon: "layers" },
  { name: "Wool socks", detail: "Pack of 3", price: 14, stock: 20, icon: "spark" },
];
/** The order total from which shipping is free. */
const FREE_SHIPPING = 150;
const BILL = 84;
/** An amount in dollars and cents: `$1,204.50`. */
const money = (n: number) => {
  const [whole, cents] = n.toFixed(2).split(".");
  return `$${count(Number(whole))}.${cents}`;
};

/** The controls, one demo each in the sidebar. */
export type Control =
  | "Switch"
  | "Checkbox"
  | "Radio"
  | "Tabs"
  | "Select"
  | "Combobox"
  | "DatePicker"
  | "Collapsible"
  | "Progress"
  | "Slider"
  | "NumberInput"
  | "OtpInput";

/**
 * One of `nsh/base`'s controls (`Switch`, `Checkbox`, `Radio` and
 * `RadioGroup`, `Tab` and `Tabs`, `Select`, `Combobox`, `DatePicker`, `Collapsible`, `Progress`, `Slider`) in
 * the settings, filters, pickers, section switchers, choices and disclosures apps use
 * it for, then in other looks, sizes and states (choice cards, tiles,
 * underlined tabs, an accordion), above the last event it reported.
 */
export function Controls(props: { show: Control; firsts?: Control[] }) {
  const last = signal("—");

  function Settings() {
    const notifications = signal(true);
    const badges = signal(true);
    const previews = signal(false);
    const haptics = signal(false);
    const lowData = signal(false);
    function Setting(props: { label: string; detail: string; icon: IconName; on: boolean; set: (on: boolean) => void; disabled?: boolean; first?: boolean }) {
      const look = switchLook(() => props.on, size.switch);
      return (
        <Switch
          checked={props.on}
          disabled={props.disabled}
          onChange={({ checked: on }) => {
            props.set(on);
            last.set(`${props.label}: ${on ? "on" : "off"}`);
          }}
          // The track at the trailing edge, after the label; the icon leads.
          {...listRow({ first: props.first, disabled: () => props.disabled, style: { flexDirection: "row-reverse" } })}
          trackClass={look.trackClass}
          trackStyle={look.trackStyle}
          thumbStyle={look.thumbStyle}
        >
          <RowDivider show={!props.first} />
          <RowLabel label={props.label} detail={props.detail} />
          <IconTile name={props.icon} size={pointer ? 26 : 32} tint={props.on ? colors.accent : colors.muted} />
        </Switch>
      );
    }
    /** A group's heading in the settings list, in sentence case. */
    function Group(props: { title: string; first?: boolean }) {
      return <Text style={{ marginTop: props.first ? 0 : size.gap, marginBottom: 2, fontSize: 12, fontWeight: "600", color: colors.muted }}>{props.title}</Text>;
    }
    const off = "Turn on notifications first";
    return (
      <Card icon="controls" title="Switch" subtitle="Two groups; two settings need another on">
        <View>
          <Group first title="Alerts" />
          <Setting
            first
            label="Notifications"
            icon="bell"
            detail={notifications() ? "Banners, sounds and badges" : "Off"}
            on={notifications()}
            set={(on) => notifications.set(on)}
          />
          <Setting
            label="Badges"
            icon="spark"
            detail={notifications() ? "The unread count on the icon" : off}
            on={badges()}
            disabled={!notifications()}
            set={(on) => badges.set(on)}
          />
          <Setting
            label="Previews"
            icon="chat"
            detail={notifications() ? (previews() ? "The message's text in banners" : "Only who wrote") : off}
            on={previews()}
            disabled={!notifications()}
            set={(on) => previews.set(on)}
          />
          <Group title="Device" />
          <Setting first label="Haptics" icon="gestures" detail="A tap under the finger as values change" on={haptics()} set={(on) => haptics.set(on)} />
          <Setting label="Low data mode" icon="storage" detail={lowData() ? "Images load at a lower quality" : "Images load in full"} on={lowData()} set={(on) => lowData.set(on)} />
        </View>
      </Card>
    );
  }

  function Quick() {
    const on = signal<string[]>(["Sounds", "Night Shift"]);
    const has = (name: string) => on().includes(name);
    // Focus silences the sounds: turning it on turns them off and holds them.
    const held = (name: string) => name === "Sounds" && has("Focus");
    /** A quick setting: a tile whose icon lights up and pops as it changes, its switch in the corner. */
    function QuickTile(props: { name: string; icon: "moon" | "sun" | "bell" | "spark"; detail: string }) {
      const t = follow(() => (has(props.name) ? 1 : 0));
      const pop = popOn(() => has(props.name));
      const look = switchLook(() => has(props.name), "small");
      const away = t.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
      return (
        <Switch
          checked={has(props.name)}
          disabled={held(props.name)}
          onChange={({ checked }) => {
            let next = checked ? [...on(), props.name] : on().filter((n) => n !== props.name);
            if (props.name === "Focus" && checked) next = next.filter((n) => n !== "Sounds");
            on.set(next);
            last.set(`${props.name}: ${checked ? "on" : "off"}`);
          }}
          {...choiceTileLook(() => has(props.name), { disabled: () => held(props.name), style: { width: "48%", flex: undefined, gap: 2 } })}
          trackClass={look.trackClass}
          // Level with the icon's circle (32 high under the tile's 14 of padding).
          trackStyle={{ ...look.trackStyle, position: "absolute", top: cornerTop(14 + 16, look.trackStyle.height as number, 12), end: 12 }}
          thumbStyle={look.thumbStyle}
        >
          <View style={{ width: 32, height: 32, marginBottom: 8, borderRadius: 16, alignItems: "center", justifyContent: "center", borderWidth: 1, ...choiceWell(), transform: [{ scale: pop }] }}>
            <ChoiceLight on={t} radius={16} />
            <View style={{ ...centered, opacity: away }}>
              <Icon name={props.icon} size={16} tint={colors.muted} />
            </View>
            <View style={{ ...centered, opacity: t }}>
              <Icon name={props.icon} size={16} tint={colors.onAccent} />
            </View>
          </View>
          <Text style={{ fontSize: size.label, fontWeight: "600", color: colors.text }}>{props.name}</Text>
          <Text style={{ fontSize: size.detail, color: colors.muted }}>{held(props.name) ? "Silenced by Focus" : has(props.name) ? props.detail : "Off"}</Text>
        </Switch>
      );
    }
    return (
      <Card title="Quick settings" subtitle="The icon lights up with the switch">
        <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: 8 }}>
          <QuickTile name="Focus" icon="moon" detail="Until tomorrow" />
          <QuickTile name="Night Shift" icon="sun" detail="Until 7:00" />
          <QuickTile name="Sounds" icon="bell" detail="Ring and alerts" />
          <QuickTile name="Low power" icon="spark" detail="Background work paused" />
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
      <Card icon="controls" title="Checkbox" subtitle="“Select all” shows a partial selection" right={<Badge label={`${shown().length} of ${KINDS.length}`} />}>
        <View>
          <Checkbox
            checked={all()}
            indeterminate={mark() === "dash"}
            onChange={({ checked: on }) => {
              sound("toggle", { rate: on ? 1 : 0.9 });
              shown.set(on ? KINDS.map((k) => k.name) : []);
              last.set(`Select all: ${on}`);
            }}
            class="group"
            {...listRow({ first: true })}
            {...checkboxLook()}
            indicator={<CheckboxMark mark={mark()} />}
          >
            <Text style={{ flex: 1, fontSize: size.label, fontWeight: "600", color: colors.text }}>Select all</Text>
          </Checkbox>
          <Each of={KINDS}>
            {(kind) => (
              <Checkbox
                checked={has(kind().name)}
                onChange={({ checked: on }) => {
                  sound("toggle", { rate: on ? 1 : 0.9 });
                  shown.set(on ? KINDS.map((k) => k.name).filter((n) => n === kind().name || has(n)) : shown().filter((n) => n !== kind().name));
                  last.set(`${kind().name}: ${on}`);
                }}
                // One level under "Select all": the boxes line up with its label.
                class="group"
                {...listRow({ start: size.control + size.gap })}
                {...checkboxLook()}
                indicator={<CheckboxMark mark={has(kind().name) ? "check" : null} />}
              >
                <RowDivider show />
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

  function Checklist() {
    const done = signal<string[]>(["Freeze the API", "Write the release notes"]);
    const has = (task: string) => done().includes(task);
    const left = () => TASKS.length - done().length;
    /** A task: a round box, its label fading back and struck through once done. */
    function Task(props: { task: string; first: boolean }) {
      const on = follow(() => (has(props.task) ? 1 : 0));
      return (
        <Checkbox
          checked={has(props.task)}
          onChange={({ checked: on }) => {
            sound("toggle", { rate: on ? 1 : 0.9 });
            done.set(on ? [...done(), props.task] : done().filter((t) => t !== props.task));
            last.set(`${props.task}: ${on ? "done" : "to do"}`);
          }}
          class="group"
          {...listRow({ first: props.first })}
          {...checkboxLook({ round: true })}
          indicator={<CheckboxMark mark={has(props.task) ? "check" : null} round />}
        >
          <RowDivider show={!props.first} />
          <Text
            style={{
              flex: 1,
              fontSize: size.label,
              color: on.interpolate({ inputRange: [0, 1], outputRange: [colors.text, colors.faint] }),
              textDecorationLine: has(props.task) ? "line-through" : "none",
            }}
          >
            {props.task}
          </Text>
        </Checkbox>
      );
    }
    return (
      <Card title="Checklist" subtitle="A task done fades back; the bar fills" right={<Badge label={`${done().length} of ${TASKS.length}`} tone={left() === 0 ? "up" : "neutral"} />}>
        <View>
          <Each of={TASKS}>{(task, i) => <Task task={task()} first={i() === 0} />}</Each>
        </View>
        <Progress value={(done().length / TASKS.length) * 100} accessibilityLabel="Release readiness" {...progressLook(() => (done().length / TASKS.length) * 100, { height: 4 })} />
        <Caption label={left() === 0 ? "Ready to ship" : `${left()} to go before the release`} />
      </Card>
    );
  }

  function Consent() {
    const allowed = signal<string[]>(["Analytics"]);
    const has = (name: string) => allowed().includes(name);
    const saved = signal(false);
    const set = (next: string[]) => {
      allowed.set(next);
      saved.set(false);
    };
    return (
      <Card title="Consent" subtitle="A description each; the necessary one stays on">
        <View>
          <Each of={COOKIES}>
            {(c, i) => (
              <Checkbox
                checked={c().required || has(c().name)}
                disabled={c().required}
                onChange={({ checked }) => {
                  sound("toggle", { rate: checked ? 1 : 0.9 });
                  set(checked ? [...allowed(), c().name] : allowed().filter((n) => n !== c().name));
                  last.set(`${c().name}: ${checked}`);
                }}
                class="group"
                // The box at the first line of the label, not its middle.
                {...listRow({ first: i() === 0, disabled: () => c().required, style: { alignItems: "flex-start" } })}
                // The necessary one reads as on rather than unavailable.
                disabledStyle={{ opacity: 0.5 }}
                indicatorClass={checkboxLook().indicatorClass}
                indicatorStyle={{ ...checkboxLook({ disabled: c().required }).indicatorStyle, marginTop: 2 }}
                indicator={<CheckboxMark mark={c().required || has(c().name) ? "check" : null} />}
              >
                <RowDivider show={i() !== 0} />
                {/* A terminal keeps the names in one column: "always on" goes with the description. */}
                <RowLabel
                  label={c().required && !terminal ? `${c().name} (always on)` : c().name}
                  detail={c().required && terminal ? `Always on · ${c().detail}` : c().detail}
                  width={labelColumn(COOKIES.map((k) => k.name))}
                />
              </Checkbox>
            )}
          </Each>
        </View>
        <View style={{ flexDirection: "row", gap: size.gap, alignSelf: pointer ? "flex-end" : "stretch" }}>
          <Button
            label="Accept all"
            variant="secondary"
            size={size.switch}
            flex={pointer ? undefined : 1}
            onPress={() => {
              set(COOKIES.filter((c) => !c.required).map((c) => c.name));
              last.set("Consent: all accepted");
            }}
          />
          <Button
            label={saved() ? "Saved" : "Save choices"}
            size={size.switch}
            flex={pointer ? undefined : 1}
            disabled={saved()}
            onPress={() => {
              saved.set(true);
              last.set(`Consent: ${allowed().join(", ") || "necessary only"}`);
            }}
          />
        </View>
      </Card>
    );
  }

  function Channels() {
    const on = signal<string[]>(["Push"]);
    const has = (name: string) => on().includes(name);
    return (
      <Card title="Choice cards" subtitle="The whole card is the checkbox">
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Each of={CHANNELS}>
            {(c) => (
              <Checkbox
                checked={has(c().name)}
                disabled={c().disabled}
                onChange={({ checked }) => {
                  sound("toggle", { rate: checked ? 1 : 0.9 });
                  on.set(checked ? [...on(), c().name] : on().filter((n) => n !== c().name));
                  last.set(`${c().name}: ${checked}`);
                }}
                class="group"
                {...choiceTileLook(() => has(c().name), { disabled: () => c().disabled })}
                // The box in the card's corner.
                indicatorClass={checkboxLook().indicatorClass}
                // Level with the 18-point icon.
                indicatorStyle={{ ...checkboxLook({ scale: 0.8, disabled: c().disabled }).indicatorStyle, position: "absolute", top: cornerTop(14 + 9, smallChoice, 10), right: 12 }}
                indicator={<CheckboxMark mark={has(c().name) ? "check" : null} scale={0.8} />}
              >
                <Icon name={c().icon} size={18} tint={has(c().name) ? colors.accent : colors.muted} />
                <Text style={{ marginTop: 6, fontSize: size.label, fontWeight: "600", color: colors.text }}>{c().name}</Text>
                <Text style={{ fontSize: size.detail, color: colors.muted }}>{c().detail}</Text>
              </Checkbox>
            )}
          </Each>
        </View>
        <Caption label={on().length ? `Notifying you by ${on().join(" and ").toLowerCase()}` : "No notifications"} />
      </Card>
    );
  }

  function BoxStates() {
    const sizes = signal<string[]>(["Regular"]);
    const has = (name: string) => sizes().includes(name);
    /** A checkbox and its label on one line, `scale` times the page's size. */
    function Inline(props: { label: string; mark: Mark; scale?: number; disabled?: boolean; onChange?: (checked: boolean) => void }) {
      return (
        <Checkbox
          checked={props.mark === "check"}
          indeterminate={props.mark === "dash"}
          disabled={props.disabled}
          onChange={({ checked }) => {
            sound("toggle", { rate: checked ? 1 : 0.9 });
            props.onChange?.(checked);
          }}
          class="group"
          style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 }}
          activeStyle={pressed}
          focusVisibleStyle={focusRing(2)}
          disabledStyle={dimmed}
          {...checkboxLook({ scale: props.scale, disabled: () => !!props.disabled })}
          indicator={<CheckboxMark mark={props.mark} scale={props.scale} />}
        >
          <Text style={{ fontSize: size.label, color: colors.text }}>{props.label}</Text>
        </Checkbox>
      );
    }
    const line = { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, columnGap: 20, rowGap: 6 };
    return (
      <Card title="Sizes and states" subtitle="Three sizes; disabled in every state">
        <View style={line}>
          <Each of={SIZES}>
            {(z) => (
              <Inline
                label={z().name}
                scale={z().scale}
                mark={has(z().name) ? "check" : null}
                onChange={(checked) => {
                  sizes.set(checked ? [...sizes(), z().name] : sizes().filter((n) => n !== z().name));
                  last.set(`${z().name}: ${checked}`);
                }}
              />
            )}
          </Each>
        </View>
        <View style={{ height: 1, backgroundColor: colors.line }} />
        <View style={line}>
          <Inline label="Unavailable" mark={null} disabled />
          <Inline label="Required" mark="check" disabled />
          <Inline label="Partly set" mark="dash" disabled />
        </View>
        <Caption label={pointer ? "Hover and Tab to each: the disabled ones take neither" : "The disabled ones take no press"} />
      </Card>
    );
  }

  function Plans() {
    const plan = signal("Plus");
    const chosen = () => PLANS.find((p) => p.name === plan())!;
    return (
      <Card icon="controls" title="Radio" subtitle="A plan picker: one of a small set, all in view">
        <RadioGroup accessibilityLabel="Plan">
          <Each of={PLANS}>
            {(p, i) => (
              <Radio
                checked={plan() === p().name}
                disabled={p().disabled}
                onChange={() => {
                  sound("select");
                  plan.set(p().name);
                  last.set(`Plan: ${p().name}`);
                }}
                class="group"
                // The ring at the first line of the label, as the consent rows' boxes are.
                {...listRow({ first: i() === 0, disabled: () => p().disabled, style: { alignItems: "flex-start" } })}
              >
                <RowDivider show={i() !== 0} />
                <View style={{ marginTop: 2 }}>
                  <RadioRing on={plan() === p().name} disabled={p().disabled} />
                </View>
                <RowLabel label={p().name} detail={p().detail} />
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

  function Delivery() {
    const speed = signal("Standard");
    return (
      <Card title="Choice cards" subtitle="The whole card is the radio">
        <RadioGroup accessibilityLabel="Delivery" style={{ flexDirection: "row", gap: 8 }}>
          <Each of={SPEEDS}>
            {(d) => (
              <Radio
                checked={speed() === d().name}
                disabled={d().disabled}
                onChange={() => {
                  sound("select");
                  speed.set(d().name);
                  last.set(`Delivery: ${d().name}`);
                }}
                class="group"
                {...choiceTileLook(() => speed() === d().name, { disabled: () => d().disabled })}
              >
                {/* Level with the title's line. */}
                <View style={{ position: "absolute", top: cornerTop(14 + Math.round(size.label * 0.65), smallChoice, 10), right: 12 }}>
                  <RadioRing on={speed() === d().name} scale={0.8} disabled={d().disabled} />
                </View>
                <Text style={{ marginRight: 20, fontSize: size.label, fontWeight: "600", color: colors.text }}>{d().name}</Text>
                <Text style={{ fontSize: size.detail, color: colors.muted }}>{d().detail}</Text>
                {/* At the tile's foot, so the prices line up across tiles whatever the details' lines. */}
                <Text style={{ marginTop: "auto", paddingTop: 8, fontSize: size.label, color: speed() === d().name ? colors.accent : colors.text, fontVariant: ["tabular-nums"] }}>{d().price}</Text>
              </Radio>
            )}
          </Each>
        </RadioGroup>
      </Card>
    );
  }

  function Reading() {
    const choice = signal("Medium");
    const chosen = () => TEXT_SIZES.find((t) => t.name === choice())!;
    const preview = settleOn(choice);
    return (
      <Card title="Sizes" subtitle="Three sizes, one locked; the preview follows">
        <RadioGroup accessibilityLabel="Text size" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 20, rowGap: 6 }}>
          <Each of={TEXT_SIZES}>
            {(t) => (
              <Radio
                checked={choice() === t().name}
                disabled={t().disabled}
                onChange={() => {
                  sound("select");
                  choice.set(t().name);
                  last.set(`Text size: ${t().name}`);
                }}
                class="group"
                style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 }}
                activeStyle={pressed}
                focusVisibleStyle={focusRing(2)}
                disabledStyle={dimmed}
              >
                <RadioRing on={choice() === t().name} scale={t().scale} disabled={t().disabled} />
                <Text style={{ fontSize: size.label, color: colors.text }}>{t().name}</Text>
              </Radio>
            )}
          </Each>
        </RadioGroup>
        <View style={{ ...insetSurface(), padding: 12 }}>
          <View style={settle(preview)}>
            <Text style={{ fontSize: chosen().text, lineHeight: Math.round(chosen().text * 1.45), color: colors.text }}>
              Native views, styled by the app: every state and every motion is the gallery's own.
            </Text>
          </View>
        </View>
      </Card>
    );
  }

  function Sections() {
    const section = signal("Overview");
    const shown = () => SECTIONS.find((s) => s.name === section())!;
    const look = tabsLook();
    // The track's padding and border (`tabsLook`'s): a tab is a pill inside them.
    const inset = 3;
    const rows = settleOn(section);
    // The tabs share the track equally: icons show while every title fits
    // its share with its icon (a tab's border and padding are 14).
    const sized = titles(SECTIONS.length);
    const icons = () => {
      const widths = sized.widths();
      const share = (sized.room() - 2 * (inset + 1) - 2 * (SECTIONS.length - 1)) / SECTIONS.length;
      return widths.length > 0 && widths.every((w) => w + TAB_ICON_ROOM + 14 <= share);
    };
    return (
      <Card icon="controls" title="Tabs" subtitle="A section switcher: the app shows the selected one">
        {/* The pill under the selected tab, inside the track's padding: the list's indicator, which the core places
            on the selected tab and springs to the next one natively (gpui-kit's `spring_move`). */}
        <Tabs
          onLayout={({ bounds }) => sized.room.set(bounds.size.width)}
          style={look.style}
          indicatorStyle={look.indicatorStyle}
        >
          <Each of={SECTIONS}>
            {(s, i) => (
              <Tab
                selected={section() === s().name}
                disabled={s().disabled}
                onPress={() => {
                  section.set(s().name);
                  last.set(`Tab: ${s().name}`);
                }}
                {...look.tab({ selected: () => section() === s().name, disabled: () => s().disabled })}
              >
                <TabTitle name={s().name} icon={icons() ? s().icon : undefined} onWidth={sized.report(i())} selected={section() === s().name} />
              </Tab>
            )}
          </Each>
        </Tabs>
        <View style={settle(rows)}>
          <Each of={shown().rows}>
            {(r, i) => (
              // The overview's figures lead, their names quieter; other sections lead with the name.
              <View style={plainRow({ first: i() === 0, dense: true })}>
                <Text style={{ flex: 1, fontSize: size.label, color: shown().name === "Overview" ? colors.muted : colors.text }}>{r()[0]}</Text>
                <Text
                  style={{
                    fontSize: size.label,
                    fontWeight: shown().name === "Overview" ? "500" : "400",
                    color: shown().name === "Overview" ? colors.text : colors.muted,
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {r()[1]}
                </Text>
              </View>
            )}
          </Each>
        </View>
      </Card>
    );
  }

  function Project() {
    const tab = signal("Issues");
    const shown = () => PROJECT.find((t) => t.name === tab())!;
    const rows = settleOn(tab);
    const look = underlineTabsLook();
    // Icons show while the whole strip fits the card with them (a tab's
    // border and padding are 18, 2 between tabs); without them it scrolls
    // when it still does not fit.
    const sized = titles(PROJECT.length);
    const icons = () => {
      const widths = sized.widths();
      return widths.length > 0 && widths.reduce((sum, w) => sum + w + TAB_ICON_ROOM + 18, 2 * (PROJECT.length - 1)) <= sized.room();
    };
    return (
      <Card title="Underlined" subtitle="As wide as their labels; the line travels">
        {/* The strip scrolls when the labels do not fit; the hairline under it is outside the scroll view, so the
            strip's clipping never cuts it, and the underline (at the strip's bottom) covers it. */}
        <View onLayout={({ bounds }) => sized.room.set(bounds.size.width)} style={{ marginHorizontal: -8 }}>
          {/* The hairline runs from one edge of the card to the other, so its ends never hang in the padding. */}
          <View style={terminal ? look.rule : { ...look.rule, left: 8 - density.pad, right: 8 - density.pad }} />
          <Scroll horizontal scrollbar={false} style={{ flexGrow: 0 }}>
            {/* The underline: the list's indicator at its bottom, as wide as the selected tab, which travels and
                stretches to the next one natively. */}
            <Tabs style={look.style} indicatorStyle={look.indicatorStyle}>
              <Each of={PROJECT}>
                {(t, i) => (
                  <Tab
                    selected={tab() === t().name}
                    disabled={t().disabled}
                    onPress={() => {
                      tab.set(t().name);
                      last.set(`Project: ${t().name}`);
                    }}
                    {...look.tab({ selected: () => tab() === t().name, disabled: () => t().disabled })}
                  >
                    <TabTitle name={t().name} icon={icons() ? t().icon : undefined} onWidth={sized.report(i())} count={t().count} selected={tab() === t().name} underline />
                  </Tab>
                )}
              </Each>
            </Tabs>
          </Scroll>
        </View>
        <View style={settle(rows)}>
          <Each of={shown().rows}>
            {(r, i) => (
              <View style={plainRow({ first: i() === 0, dense: true })}>
                <Icon name={shown().icon} size={size.check} tint={colors.faint} />
                <Text style={{ flex: 1, numberOfLines: 1, fontSize: size.label, color: colors.text }}>{r()[0]}</Text>
                <Text style={{ fontSize: size.detail, color: colors.faint, fontVariant: ["tabular-nums"] }}>{r()[1]}</Text>
              </View>
            )}
          </Each>
        </View>
      </Card>
    );
  }

  // The lists' look is the shared one (`look/listbox.tsx`): `Picker`, `OptionRow`, `ListboxHeader`, `comboboxLook`.
  /** A field's message under it: an error in the danger tone, settling in as it shows. */
  function Message(props: { label: string; tone?: Tone }) {
    const t = settleOn(() => props.label);
    return (
      <View style={settle(t)}>
        <Text style={{ fontSize: size.detail, color: props.tone ? toneColor(props.tone) : colors.muted }}>{props.label}</Text>
      </View>
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
            <RowLabel label="Sort by" detail={pointer ? "A letter jumps to an order" : "Five orders in a sheet"} />
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
              popupStyle={listboxPopup()}
              backdropStyle={backdrop()}
              itemClass={optionClass}
              trigger={<Picker title={titleOf(SORTS, sort())} open={sortOpen()} />}
              renderItem={(item) => <OptionRow item={item} />}
            />
          </View>
          <View style={row(false)}>
            <RowLabel label="Font" detail="Searched, in sections" />
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
              searchAccessibilityLabel="Search fonts"
              {...listboxSearch()}
              empty={<ListboxEmpty label="No font matches" />}
              offset={4}
              margin={8}
              align="end"
              popupStyle={listboxPopup({ minWidth: 260 })}
              backdropStyle={backdrop()}
              itemClass={optionClass}
              cleanable
              clearButtonAccessibilityLabel="Clear the font"
              {...clearButtonLook({ over: true })}
              trigger={<Picker title={font() === null ? "Default" : titleOf(FONTS, font())} open={fontOpen()} placeholder={font() === null} clearable={font() !== null} />}
              renderItem={(item) => <OptionRow item={item} note={item.disabled ? "Not installed" : undefined} />}
              renderGroup={(group) => <ListboxHeader group={group} />}
            />
          </View>
          <View style={row(false)}>
            <RowLabel label="Language" detail="Set by your organization" />
            <Select items={LANGUAGES} value="en" disabled accessibilityLabel="Language" trigger={<Picker title="English" open={false} disabled />} />
          </View>
        </View>
      </Card>
    );
  }

  /** What the lists of the cards below share: as wide as the trigger with a pointer (wider with `minWidth`), a sheet on a phone. */
  const listProps = (minWidth?: number) => ({
    offset: 4,
    margin: 8,
    align: "end" as const,
    get popupStyle() {
      return listboxPopup({ minWidth });
    },
    get backdropStyle() {
      return backdrop();
    },
    itemClass: optionClass,
  });
  /** A clear button over the trigger's end, in place of its chevron (`Picker`'s `clearable`). */
  const clearProps = (label: string) => ({ cleanable: true, clearButtonAccessibilityLabel: label, ...clearButtonLook({ over: true }) });

  function Downloads() {
    const sort = signal<DownloadSort>("added");
    const down = signal(true);
    const open = signal(false);
    const order = DOWNLOAD_SORTS.map(({ value, title }) => ({ value, title }));
    const sortTitle = () => titleOf(order, sort());
    /** How the order runs, in words: what comes first. */
    const way = () => {
      const s = sort();
      if (s === "added") return down() ? "newest first" : "oldest first";
      if (s === "size") return down() ? "largest first" : "smallest first";
      return down() ? "Z to A" : "A to Z";
    };
    // Each order's natural way (names A to Z, the oldest and smallest first), turned round while `down`.
    const sorted = computed(() => {
      const s = sort();
      const by = (a: (typeof DOWNLOADS)[number], b: (typeof DOWNLOADS)[number]) =>
        s === "name" ? a.name.localeCompare(b.name) : s === "kind" ? a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) : s === "size" ? a.mb - b.mb : b.days - a.days;
      const out = DOWNLOADS.slice().sort(by);
      return down() ? out.reverse() : out;
    });
    // The rows move to their new places (`animateLayout`), and the column sorted on leads at the trailing edge.
    const set = (next: DownloadSort, nextDown: boolean) => {
      animateLayout();
      sort.set(next);
      down.set(nextDown);
      last.set(`Downloads: ${sortTitle()}, ${way()}`);
    };
    const trailing = (f: (typeof DOWNLOADS)[number]) => (sort() === "size" ? fileSize(f.mb) : sort() === "kind" ? f.kind : ago(f.days));
    const detail = (f: (typeof DOWNLOADS)[number]) =>
      sort() === "size" ? `${f.kind} · ${ago(f.days)}` : sort() === "kind" ? `${fileSize(f.mb)} · ${ago(f.days)}` : `${f.kind} · ${fileSize(f.mb)}`;
    return (
      <Card title="In a list header" subtitle="A sort menu over the rows it orders">
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingBottom: size.padding, borderBottomWidth: 1, borderColor: colors.line }}>
          <Text style={{ flex: 1, fontSize: 11, fontWeight: "600", letterSpacing: 0.6, color: colors.faint }}>{`DOWNLOADS · ${DOWNLOADS.length}`}</Text>
          <Select
            items={order}
            value={sort()}
            onChange={({ value }) => {
              const next = DOWNLOAD_SORTS.find((s) => s.value === value);
              if (next) set(next.value, next.down);
            }}
            onOpenChange={opened((o) => open.set(o))}
            accessibilityLabel="Sort downloads"
            {...listProps(180)}
            trigger={
              // A ghost trigger, as list headers have: bare until the pointer is over it, filled while open.
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  height: pointer ? 26 : 34,
                  paddingHorizontal: 8,
                  borderRadius: radius.control,
                  backgroundColor: open() ? token("accent") : "transparent",
                  transitionProperty: "background-color",
                  transitionDuration: reduceMotion() ? 0 : 120,
                }}
                hoverStyle={open() ? undefined : hovered()}
                activeStyle={pressed}
                focusVisibleStyle={focusRing()}
              >
                <Text style={{ fontSize: size.detail, color: colors.muted }}>Sort by</Text>
                <Text style={{ fontSize: size.detail, fontWeight: "500", color: colors.text }}>{sortTitle()}</Text>
                {/* In the terminal, room after the gap for the select's own `▾` and the blank after it, two Cells (a bare trigger takes no padding there). */}
                <If when={terminal} else={<Chevron open={open()} />}>
                  <View style={{ width: TERMINAL_COLUMN + 1 }} />
                </If>
              </View>
            }
            renderItem={(item) => <OptionRow item={item} />}
          />
          {/* The way the order runs: the arrow turns over. */}
          <BaseButton
            accessibilityLabel={down() ? "Descending" : "Ascending"}
            onPress={() => set(sort(), !down())}
            class="items-center justify-center rounded-md enabled:hover:bg-accent active:bg-track"
            style={{ width: pointer ? 26 : 34, height: pointer ? 26 : 34 }}
            focusVisibleStyle={focusRing()}
          >
            <View class="transition-transform duration-200 motion-reduce:transition-none" style={{ transform: [{ rotate: down() ? "0deg" : "180deg" }] }}>
              <Icon name="arrow-down" size={pointer ? 14 : 16} tint={colors.muted} />
            </View>
          </BaseButton>
        </View>
        <View>
          <Each of={sorted()}>
            {(f, i) => (
              <View style={{ ...row(i() === 0), paddingVertical: 4 }}>
                <IconTile name={f().icon} size={pointer ? 26 : 32} tint={colors.muted} />
                <RowLabel label={f().name} detail={detail(f())} width={labelColumn(DOWNLOADS.map((d) => d.name))} />
                <Text style={{ fontSize: size.detail, color: colors.text, fontVariant: ["tabular-nums"] }}>{trailing(f())}</Text>
              </View>
            )}
          </Each>
        </View>
      </Card>
    );
  }

  function Shipping() {
    const country = signal<string | null>("jp");
    const open = signal(false);
    const chosen = () => COUNTRIES.find((c) => c.value === country());
    const of = (value: string) => COUNTRIES.find((c) => c.value === value)!;
    // The facts settle in again for each country.
    const t = settleOn(country);
    function Flag(props: { value: string }) {
      return <Text style={{ fontSize: pointer ? 15 : 18 }}>{of(props.value).flag}</Text>;
    }
    /** One fact of the delivery: a label over its value, after a hairline but the first. */
    function Fact(props: { label: string; value: string; first?: boolean }) {
      return (
        <View style={{ flex: 1, gap: 2, paddingLeft: props.first ? 0 : size.gap, borderLeftWidth: props.first ? 0 : 1, borderColor: colors.line }}>
          <Text style={{ fontSize: size.detail, color: colors.muted }}>{props.label}</Text>
          <Text style={{ fontSize: size.label, fontWeight: "500", color: colors.text, fontVariant: ["tabular-nums"] }}>{props.value}</Text>
        </View>
      );
    }
    return (
      <Card title="Shipping" subtitle="Countries by region with flags; search narrows">
        <View style={row(true)}>
          <RowLabel label="Country" detail="Where your order goes" />
          <Select
            items={COUNTRY_ITEMS}
            value={country()}
            onChange={({ value }) => {
              country.set(value);
              last.set(`Country: ${titleOf(COUNTRIES, value)}`);
            }}
            onOpenChange={opened((o) => open.set(o))}
            accessibilityLabel="Country"
            searchable
            searchPlaceholder="Search countries"
            searchAccessibilityLabel="Search countries"
            {...listboxSearch()}
            empty={<ListboxEmpty label="We do not ship there" />}
            {...listProps(260)}
            trigger={<Picker title={chosen()?.title ?? "Choose"} lead={chosen() ? <Flag value={chosen()!.value} /> : undefined} open={open()} />}
            renderItem={(item) => <OptionRow item={item} lead={<Flag value={item.value} />} note={item.disabled ? "Not yet" : of(item.value).dial} />}
            renderGroup={(group) => <ListboxHeader group={group} />}
          />
        </View>
        <View style={{ flexDirection: "row", paddingTop: size.padding, borderTopWidth: 1, borderColor: colors.line, ...settle(t) }}>
          <Fact first label="Arrives in" value={chosen()?.days ?? "—"} />
          <Fact label="Prices in" value={chosen()?.currency ?? "—"} />
          <Fact label="Calling code" value={chosen()?.dial ?? "—"} />
        </View>
      </Card>
    );
  }

  function Issue() {
    const status = signal<string | null>("progress");
    const team = signal<string | null>(null);
    const statusOpen = signal(false);
    const teamOpen = signal(false);
    // The team is required: once filing was tried without one, its trigger is edged in red and says so.
    const tried = signal(false);
    const filed = signal(0);
    const missing = () => tried() && team() === null;
    const shake = createMotion();
    cleanup(() => shake.stop());
    const pop = popOn(filed);
    const file = () => {
      if (team() === null) {
        tried.set(true);
        if (!terminal) shake.play("shake");
        last.set("Issue: a team is required");
        return;
      }
      filed.set(filed() + 1);
      last.set(`Issue filed: ${titleOf(STATUS_ITEMS, status())}, ${titleOf(TEAMS, team())}`);
    };
    return (
      <Card title="Status and validation" subtitle="Colored statuses, a required team, a locked one">
        <View>
          <View style={row(true)}>
            <RowLabel label="Status" detail="Its dot follows the choice" />
            <Select
              items={STATUS_ITEMS}
              value={status()}
              onChange={({ value }) => {
                status.set(value);
                last.set(`Status: ${titleOf(STATUS_ITEMS, value)}`);
              }}
              onOpenChange={opened((o) => statusOpen.set(o))}
              accessibilityLabel="Status"
              {...listProps(180)}
              trigger={<Picker title={titleOf(STATUS_ITEMS, status())} lead={<Dot color={statusColor(status())} />} open={statusOpen()} />}
              renderItem={(item) => <OptionRow item={item} lead={<Dot color={statusColor(item.value)} />} />}
            />
          </View>
          <View style={row(false)}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: size.label, color: colors.text }}>Team</Text>
              <Message label={missing() ? "Choose a team to file the issue" : "Required: who picks it up"} tone={missing() ? "danger" : undefined} />
            </View>
            <View style={shake.style}>
              <Select
                items={TEAMS}
                value={team()}
                onChange={({ value }) => {
                  team.set(value);
                  last.set(`Team: ${titleOf(TEAMS, value)}`);
                }}
                onOpenChange={opened((o) => teamOpen.set(o))}
                accessibilityLabel="Team"
                {...listProps(180)}
                trigger={<Picker title={team() === null ? "Choose a team" : titleOf(TEAMS, team())} placeholder={team() === null} invalid={missing()} open={teamOpen()} />}
                renderItem={(item) => <OptionRow item={item} />}
              />
            </View>
          </View>
          <View style={row(false)}>
            <RowLabel label="Priority" detail="Set by the triage bot" />
            <Select items={PRIORITIES} value="high" disabled accessibilityLabel="Priority" trigger={<Picker title="High" open={false} disabled />} />
          </View>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: size.gap, marginTop: size.padding }}>
          <Button label="File issue" size="regular" flex={pointer ? undefined : 1} onPress={file} />
          <If when={filed() > 0}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, transform: [{ scale: pop }] }}>
              <Icon name="check" size={size.check} tint={toneColor("up")} weight={MARK_WEIGHT} />
              <Text style={{ fontSize: size.detail, color: colors.muted, fontVariant: ["tabular-nums"] }}>{`Filed as NSH-${611 + filed()}`}</Text>
            </View>
          </If>
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
          <View style={row(true, true)}>
            <RowLabel label="Topics" detail="Several, with search" />
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
              {...comboboxLook(() => topicsOpen(), { filled: () => topics().length > 0 })}
              placeholder={topics().length ? topicsTitle() : "Add topics"}
              triggerButton={<ComboToggle id="topics-toggle" open={topicsOpen()} />}
              empty={<ListboxEmpty label="No topic matches" />}
              offset={4}
              margin={8}
              align="end"
              popupStyle={listboxPopup()}
              backdropStyle={backdrop()}
              itemClass={optionClass}
              cleanable
              clearButtonAccessibilityLabel="Clear the topics"
              {...clearButtonLook()}
              footerStyle={{ marginTop: 6, paddingTop: 6, paddingHorizontal: terminal ? 0 : 9, borderTopWidth: 1, borderColor: colors.border }}
              footer={<Text style={{ fontSize: 12, color: colors.muted }}>{`${topics().length} selected`}</Text>}
              renderItem={(item) => <OptionRow item={item} note={item.disabled ? "Archived" : undefined} />}
              renderGroup={(group) => <ListboxHeader group={group} />}
            />
          </View>
          <View style={row(false, true)}>
            <RowLabel label="Reviewer" detail="One person at a time" />
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
              popupStyle={listboxPopup()}
              backdropStyle={backdrop()}
              itemClass={optionClass}
              {...comboboxLook(() => reviewerOpen())}
              placeholder={"Nobody"}
              triggerButton={<ComboToggle id="reviewer-toggle" open={reviewerOpen()} />}
              renderItem={(item) => <OptionRow item={item} />}
            />
          </View>
        </View>
      </Card>
    );
  }

  /** The chips of a combobox's values, under its row: they pop in, and the others close up as one goes. */
  // A terminal keeps two Cells between the chips, whose × is pressed.
  const chips = { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: terminal ? TERMINAL_GAP : 6 };

  function People() {
    const people = signal<string[]>(["ada", "grace"]);
    const open = signal(false);
    const person = (value: string) => PEOPLE.find((p) => p.value === value)!;
    const full = () => people().length >= MAX_PEOPLE;
    // Once the task has its most people, the others cannot be added (but the chosen can be taken off).
    const items = () => PEOPLE.map((p) => ({ value: p.value, title: p.title, disabled: p.disabled || (full() && !people().includes(p.value)) }));
    const set = (next: string[]) => {
      animateLayout();
      people.set(next);
      last.set(`Assignees: ${next.map((v) => person(v).title).join(", ") || "nobody"}`);
    };
    return (
      <Card title="Assignees" subtitle="Up to four people, each a chip" right={<Badge label={`${people().length} of ${MAX_PEOPLE}`} tone={full() ? "warn" : "neutral"} />}>
        <View style={row(true, true)}>
          <RowLabel label="Assignees" detail={full() ? "Four people at most" : "Who works on the task"} />
          <Combobox
            items={items()}
            multiple
            value={people()}
            onChange={({ value }) => set(value)}
            onOpenChange={opened((o) => open.set(o))}
            accessibilityLabel="Assignees"
            {...comboboxLook(() => open(), { filled: () => people().length > 0 })}
            placeholder={people().length ? `${people().length} ${people().length === 1 ? "person" : "people"}` : "Assign"}
            triggerButton={<ComboToggle id="assignees-toggle" open={open()} />}
            prefix={
              <>
              {/* The faces overlap, each ringed in the field's color; a terminal's initials stand a Cell apart, then a gap. */}
              <If when={people().length}>
                <View style={{ flexDirection: "row", marginRight: terminal ? TERMINAL_GAP : 6 }}>
                  <Each of={people().slice(0, 3)}>{(v, i) => <View style={{ marginLeft: i() ? (terminal ? TERMINAL_COLUMN : -6) : 0 }}><Avatar name={person(v()).title} tone={person(v()).tone} size={pointer ? 20 : 24} ring on={colors.field} /></View>}</Each>
                </View>
              </If>
              </>
            }
            empty={<ListboxEmpty label="Nobody by that name" />}
            {...listProps()}
            footerStyle={{ marginTop: 6, paddingTop: 6, paddingHorizontal: terminal ? 0 : 9, borderTopWidth: 1, borderColor: colors.border }}
            footer={<Text style={{ fontSize: 12, color: colors.muted }}>{full() ? "Four assigned: take one off to add another" : `${MAX_PEOPLE - people().length} more can be added`}</Text>}
            renderItem={(item) => (
              <OptionRow
                item={item}
                lead={<Avatar name={item.title} tone={person(item.value).tone} size={pointer ? 24 : 30} on={colors.raised} />}
                detail={person(item.value).role}
              />
            )}
          />
        </View>
        <View style={chips}>
          <Each of={people()}>
            {(v) => (
              <Chip
                label={person(v()).title}
                lead={<Avatar name={person(v()).title} tone={person(v()).tone} size={pointer ? 18 : 24} on={colors.raised} />}
                remove={`Remove ${person(v()).title}`}
                onRemove={() => set(people().filter((p) => p !== v()))}
              />
            )}
          </Each>
        </View>
        <If when={!people().length}>
          <Caption label="Nobody is on it yet" />
        </If>
      </Card>
    );
  }

  function Labels() {
    const labels = signal<string[]>(["bug"]);
    const made = signal<{ value: string; title: string; tone: Tone }[]>([]);
    const query = signal("");
    const open = signal(false);
    const all = () => [...LABELS, ...made()];
    const label = (value: string) => all().find((l) => l.value === value);
    // The query as a new label: offered at the end while no label has that title.
    const typed = () => query().trim();
    const fresh = () => typed() !== "" && !all().some((l) => l.title.toLowerCase() === typed().toLowerCase());
    const items = () => [...all().map(({ value, title }) => ({ value, title })), ...(fresh() ? [{ value: `${NEW_LABEL}${typed()}`, title: `Create “${typed()}”` }] : [])];
    const set = (next: string[]) => {
      animateLayout();
      labels.set(next);
      last.set(`Labels: ${next.map((v) => label(v)?.title ?? v).join(", ") || "none"}`);
    };
    return (
      <Card title="Labels" subtitle="Type a new label and Return creates it">
        <View style={row(true, true)}>
          <RowLabel label="Labels" detail="Search them, or create one" />
          <Combobox
            items={items()}
            multiple
            value={labels()}
            query={query()}
            onQueryChange={({ query: q }) => query.set(q)}
            onChange={({ value }) => {
              // The offer chosen: the label is made, and chosen under its own value.
              const created = value.find((v) => v.startsWith(NEW_LABEL));
              if (created) {
                const title = created.slice(NEW_LABEL.length);
                made.set([...made(), { value: created, title, tone: NEW_TONES[made().length % NEW_TONES.length] }]);
                query.set("");
              }
              set(value);
            }}
            onOpenChange={({ open: o }) => {
              open.set(o);
              // The app owns the query: each opening starts with an empty one.
              if (!o) query.set("");
            }}
            accessibilityLabel="Labels"
            {...comboboxLook(() => open())}
            placeholder={"Search or create labels"}
            triggerButton={<ComboToggle id="labels-toggle" open={open()} />}
            {...listProps()}
            renderItem={(item) =>
              item.value.startsWith(NEW_LABEL) && !label(item.value) ? (
                <OptionRow item={item} lead={<Icon name="plus" size={14} tint={colors.accent} />} note={pointer ? "Return" : undefined} />
              ) : (
                <OptionRow item={item} lead={<Dot color={toneColor(label(item.value)?.tone ?? "neutral")} />} note={label(item.value) && made().includes(label(item.value)!) ? "New" : undefined} />
              )
            }
          />
        </View>
        <View style={chips}>
          <Each of={labels()}>
            {(v) => (
              <Chip
                label={label(v())?.title ?? v()}
                lead={
                  <View style={{ paddingLeft: 7 }}>
                    <Dot color={toneColor(label(v())?.tone ?? "neutral")} />
                  </View>
                }
                remove={`Remove the label ${label(v())?.title ?? v()}`}
                onRemove={() => set(labels().filter((l) => l !== v()))}
              />
            )}
          </Each>
        </View>
      </Card>
    );
  }

  function Commands() {
    const ran = signal<string | null>(null);
    const open = signal(false);
    const command = (value: string) => COMMANDS.find((c) => c.value === value)!;
    const t = settleOn(ran);
    return (
      <Card title="Command list" subtitle="Grouped actions with icons and shortcuts">
        <Combobox
          items={COMMAND_ITEMS}
          // A command runs; it is not a value the list keeps.
          value={[]}
          onChange={({ value }) => {
            if (!value.length) return;
            ran.set(value[0]);
            last.set(`Command: ${command(value[0]).title}`);
          }}
          onOpenChange={opened((o) => open.set(o))}
          accessibilityLabel="Command"
          {...comboboxLook(() => open())}
          placeholder={"Search commands…"}
          // A search field has no chevron: with a pointer the shortcut's key is what a press opens the list on, the
          // field's last part; a touch screen keeps the toggle.
          triggerButton={
            pointer && !terminal ? (
              <View testID="command-toggle">
                <Kbd label="⌘K" style={{ marginLeft: 6, marginRight: 2 }} />
              </View>
            ) : (
              <ComboToggle id="command-toggle" open={open()} />
            )
          }
          prefix={
            <>
              {/* A terminal shows no icons: the placeholder says what the field does. */}
              <If when={!terminal}>
                <View style={{ marginRight: 8 }}><Icon name="search" size={size.check} tint={colors.faint} /></View>
              </If>
            </>
          }
          suffix={
            <If when={pointer && terminal}>
              <Text style={{ marginRight: TERMINAL_COLUMN, color: colors.muted }}>⌘K</Text>
            </If>
          }
          empty={<ListboxEmpty label="No command matches" />}
          {...listProps()}
          align="start"
          renderItem={(item) => (
            <OptionRow
              item={item}
              lead={
                // The icon takes the text's color while its row is highlighted.
                <View style={{ width: 14, height: 14 }}>
                  <View class="group-focus:hidden">
                    <Icon name={command(item.value).icon} size={14} tint={colors.muted} />
                  </View>
                  <View class="hidden group-focus:flex">
                    <Icon name={command(item.value).icon} size={14} tint={colors.text} />
                  </View>
                </View>
              }
              note={item.disabled ? "At 100%" : pointer ? command(item.value).keys : undefined}
            />
          )}
          renderGroup={(group) => <ListboxHeader group={group} />}
        />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, ...settle(t) }}>
          <If when={ran()} else={<Caption label="Nothing run yet" />}>
            <Icon name="check" size={size.check} tint={toneColor("up")} weight={MARK_WEIGHT} />
            <Text style={{ fontSize: size.detail, color: colors.muted }}>{`Ran “${command(ran()!).title}”`}</Text>
          </If>
        </View>
      </Card>
    );
  }

  // The calendar's look is the shared one (`calendarLook`, `CalendarItem`, `TimeSegment`).
  const { cell, monthGap, itemClass: calendarItemClass, segmentClass, content, header, calendar } = calendarLook;

  function Dates() {
    const due = signal<string | null>(null);
    const trip = signal<[string | null, string | null] | null>(null);
    const meeting = signal<string | null>(null);
    const dueOpen = signal(false);
    const tripOpen = signal(false);
    const meetingOpen = signal(false);
    // Two months side by side when the window has room for them and the presets.
    const twoMonths = () => pointer && windowSize().width >= 600;
    // The presets from today: the coming weekend, the next week and month.
    const today = new Date();
    const saturday = addDays(today, (6 - today.getDay() + 7) % 7);
    const trips: DateRangePreset[] = [
      { label: "Weekend", value: [iso(saturday), iso(addDays(saturday, 1))] },
      { label: "Next 7 days", value: [iso(today), iso(addDays(today, 6))] },
      { label: "Next 30 days", value: [iso(today), iso(addDays(today, 29))] },
    ];
    const tripTitle = () => {
      const r = trip();
      return r && r[0] && r[1] ? `${monthDay(r[0])} – ${monthDay(r[1])}` : "Pick dates";
    };
    return (
      <Card icon="controls" title="DatePicker" subtitle="A date, a range, or a date and time">
        <View>
          <View style={row(true)}>
            <RowLabel label="Due date" detail="Weekdays; clearable" />
            <DatePicker
              value={due()}
              onChange={({ value }) => {
                const next = typeof value === "string" ? value : null;
                due.set(next);
                last.set(`Due: ${next ?? "none"}`);
              }}
              onOpenChange={opened((open) => dueOpen.set(open))}
              accessibilityLabel="Due date"
              disabledMatcher={[0, 6]}
              offset={4}
              margin={8}
              align="end"
              popupStyle={listboxPopup()}
              backdropStyle={backdrop()}
              calendarStyle={calendar}
              headerStyle={header}
              itemClass={calendarItemClass}
              renderItem={(item) => <CalendarItem item={item} />}
              cleanable
              clearButtonAccessibilityLabel="Clear the due date"
              {...clearButtonLook({ over: true })}
              trigger={<DateTrigger title={due() ? shortDate(due()!) : "No due date"} open={dueOpen()} placeholder={!due()} clearable={due() !== null} />}
            />
          </View>
          <View style={row(false)}>
            <RowLabel label="Trip" detail={twoMonths() ? "A range over two months" : "A range: press its two ends"} />
            <DatePicker
              range
              value={trip()}
              onChange={({ value }) => {
                const next = Array.isArray(value) ? value : null;
                trip.set(next);
                last.set(next ? `Trip: ${next[0]} → ${next[1]}` : "Trip: none");
              }}
              onOpenChange={opened((open) => tripOpen.set(open))}
              accessibilityLabel="Trip"
              numberOfMonths={twoMonths() ? 2 : 1}
              presets={trips}
              offset={4}
              margin={8}
              align="end"
              popupStyle={listboxPopup()}
              backdropStyle={backdrop()}
              contentStyle={content}
              presetsStyle={calendarLook.presets}
              presetStyle={calendarLook.preset}
              presetClass={calendarLook.presetClass}
              calendarStyle={calendar}
              headerStyle={header}
              bodyStyle={terminal ? undefined : { gap: monthGap }}
              itemClass={calendarItemClass}
              renderItem={(item) => <CalendarItem item={item} months={twoMonths() ? 2 : 1} />}
              trigger={<DateTrigger title={tripTitle()} open={tripOpen()} placeholder={!trip()} />}
            />
          </View>
          <View style={row(false)}>
            <RowLabel label="Meeting" detail="A day, then its time" />
            <DatePicker
              value={meeting()}
              onChange={({ value }) => {
                const next = typeof value === "string" ? value : null;
                meeting.set(next);
                last.set(`Meeting: ${next ?? "none"}`);
              }}
              onOpenChange={opened((open) => meetingOpen.set(open))}
              accessibilityLabel="Meeting"
              timePrecision="minute"
              hourCycle="h23"
              defaultTime="09:00"
              offset={4}
              margin={8}
              align="end"
              popupStyle={listboxPopup()}
              backdropStyle={backdrop()}
              calendarStyle={calendar}
              headerStyle={header}
              itemClass={calendarItemClass}
              renderItem={(item) => <CalendarItem item={item} />}
              timeStyle={calendarLook.time}
              timeLabel={<Text style={{ fontSize: size.label, color: colors.muted }}>Time</Text>}
              timeAccessibilityLabel="Meeting time"
              timeFieldClass={timeFieldClass}
              segmentClass={segmentClass}
              separatorStyle={calendarLook.separator}
              renderSegment={(segment) => <TimeSegment label={segment.label} />}
              trigger={<DateTrigger title={meeting() ? shortDate(meeting()!) : "Not scheduled"} open={meetingOpen()} placeholder={!meeting()} />}
            />
          </View>
        </View>
      </Card>
    );
  }

  /** What the calendars of the cards below share: the popup's or sheet's look and the days' cells. */
  const calendarProps = (align: "start" | "end" = "end") => ({
    offset: 4,
    margin: 8,
    align,
    get popupStyle() {
      return listboxPopup();
    },
    get backdropStyle() {
      return backdrop();
    },
    calendarStyle: calendar,
    headerStyle: header,
    itemClass: calendarItemClass,
  });
  /** A line of a bill: what it is for, and the amount rolling to each new value. */
  function BillLine(props: { label: string; amount: number; total?: boolean }) {
    const pop = popOn(() => props.amount);
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: size.gap }}>
        <Text style={{ flex: 1, fontSize: props.total ? size.label : size.detail, fontWeight: props.total ? "600" : "400", color: props.total ? colors.text : colors.muted }}>{props.label}</Text>
        <View style={{ transform: [{ scale: props.total ? pop : 1 }] }}>
          <Ticker value={props.amount} text={money(props.amount)} size={props.total ? size.label + 2 : size.detail} weight={props.total ? "600" : "400"} color={props.total ? colors.text : colors.muted} />
        </View>
      </View>
    );
  }

  function Booking() {
    const today = new Date();
    const first = iso(today);
    // Two nights next week are sold out; the past cannot be booked.
    const soldOut = [iso(addDays(today, 8)), iso(addDays(today, 9))];
    const closed: DateMatcher = (date) => date < first || soldOut.includes(date);
    const stay = signal<[string | null, string | null] | null>(null);
    const open = signal(false);
    const twoMonths = () => pointer && windowSize().width >= 600;
    const complete = (): [string, string] | null => {
      const s = stay();
      return s && s[0] && s[1] ? [s[0], s[1]] : null;
    };
    const nights = () => {
      const c = complete();
      return c ? daysBetween(c[0], c[1]) : 0;
    };
    const lodging = () => {
      const c = complete();
      let sum = 0;
      for (let i = 0; c && i < nights(); i++) sum += nightRate(iso(addDays(dateOf(c[0]), i)));
      return sum;
    };
    const total = () => (nights() ? lodging() + CLEANING : 0);
    /** One end of the stay in the trigger: a small muted heading over the day, the day in the text color or a muted prompt. */
    function End(props: { label: string; value: string | null }) {
      return (
        <View style={{ flex: 1, justifyContent: "center", gap: 1, paddingHorizontal: 12 }}>
          <Text style={{ fontSize: 10, fontWeight: "600", letterSpacing: 0.6, color: colors.muted }}>{props.label.toUpperCase()}</Text>
          <Text style={{ numberOfLines: 1, fontSize: size.label, color: props.value ? colors.text : colors.muted }}>{props.value ? dayTitle(props.value) : "Add a date"}</Text>
        </View>
      );
    }
    return (
      <Card
        title="Booking"
        subtitle="Nights and price follow the dates"
        right={<Badge label={nights() ? `${nights()} ${nights() === 1 ? "night" : "nights"}` : "No dates"} tone={nights() ? "accent" : "neutral"} />}
      >
        <DatePicker
          range
          value={stay()}
          onChange={({ value }) => {
            const next = Array.isArray(value) ? value : null;
            stay.set(next);
            last.set(next ? `Stay: ${next[0]} → ${next[1]}` : "Stay: none");
          }}
          onOpenChange={opened((o) => open.set(o))}
          accessibilityLabel="Stay"
          numberOfMonths={twoMonths() ? 2 : 1}
          disabledMatcher={closed}
          {...calendarProps("start")}
          bodyStyle={terminal ? undefined : { gap: monthGap }}
          renderItem={(item) => <CalendarItem item={item} months={twoMonths() ? 2 : 1} />}
          trigger={
            // Both ends in one field, parted by a hairline; the whole field opens the calendar.
            <View
              style={{
                flexDirection: "row",
                alignItems: "stretch",
                height: pointer ? 46 : 56,
                borderRadius: radius.control,
                borderWidth: 1,
                borderColor: open() ? colors.faint : colors.border,
                backgroundColor: colors.raised,
                // Room for the date picker's ` ▾ ` over the field's end in the terminal.
                paddingRight: terminal ? 3 * TERMINAL_COLUMN : 0,
                ...finish.raised,
                transitionProperty: "border-color",
                transitionDuration: reduceMotion() ? 0 : 120,
              }}
              hoverStyle={{ borderColor: colors.faint }}
              activeStyle={pressed}
              focusVisibleStyle={focusRing()}
            >
              {/* A date picker's trigger leads with the calendar, as `DateTrigger` does. */}
              <If when={!terminal}>
                <View style={{ justifyContent: "center", paddingLeft: 12, marginRight: -4 }}>
                  <Icon name="calendar" size={pointer ? 16 : 18} tint={colors.muted} />
                </View>
              </If>
              <End label="Check-in" value={stay()?.[0] ?? null} />
              <View style={{ width: 1, marginVertical: 8, backgroundColor: colors.line }} />
              <End label="Check-out" value={stay()?.[1] ?? null} />
            </View>
          }
        />
        <If when={nights()} else={<Caption label="Fridays and Saturdays are $220 a night, other nights $180" />}>
          <View style={{ gap: 6 }}>
            <BillLine label={`${nights()} ${nights() === 1 ? "night" : "nights"}`} amount={lodging()} />
            <BillLine label="Cleaning" amount={CLEANING} />
            <View style={{ height: 1, backgroundColor: colors.line }} />
            <BillLine label="Total" amount={total()} total />
          </View>
        </If>
        <View style={{ alignItems: pointer ? "flex-end" : "stretch" }}>
          <Button
            label="Reserve"
            size="regular"
            disabled={!nights()}
            onPress={() => {
              const c = complete()!;
              last.set(`Reserved: ${c[0]} → ${c[1]}, ${money(total())}`);
            }}
          />
        </View>
      </Card>
    );
  }

  function Deadline() {
    const today = new Date();
    const due = signal<string | null>(iso(addDays(today, 2)));
    const open = signal(false);
    const monday = addDays(today, (8 - today.getDay()) % 7 || 7);
    const quick: DateRangePreset[] = [
      { label: "Today", value: iso(today) },
      { label: "Tomorrow", value: iso(addDays(today, 1)) },
      { label: "Next Monday", value: iso(monday) },
      { label: "In two weeks", value: iso(addDays(today, 14)) },
    ];
    /** How soon it is due, in words and a tone: sooner is louder. */
    const soon = (): { label: string; tone: Tone } => {
      const d = due();
      if (!d) return { label: "No deadline", tone: "neutral" };
      const days = daysBetween(iso(today), d);
      if (days === 0) return { label: "Due today", tone: "danger" };
      if (days === 1) return { label: "Due tomorrow", tone: "warn" };
      return { label: `Due in ${days} days`, tone: days <= 3 ? "warn" : "neutral" };
    };
    const t = settleOn(due);
    return (
      <Card title="Deadline" subtitle="Presets beside the calendar; no past days">
        <View>
          <View style={row(true)}>
            <View style={{ flex: 1, gap: 4, alignItems: "flex-start" }}>
              <Text style={{ fontSize: size.label, color: colors.text }}>Deadline</Text>
              <View style={settle(t)}>
                <Badge label={soon().label} tone={soon().tone} />
              </View>
            </View>
            <DatePicker
              value={due()}
              onChange={({ value }) => {
                const next = typeof value === "string" ? value : null;
                due.set(next);
                last.set(`Deadline: ${next ?? "none"}`);
              }}
              onOpenChange={opened((o) => open.set(o))}
              accessibilityLabel="Deadline"
              presets={quick}
              disabledMatcher={{ before: iso(today) }}
              {...calendarProps()}
              contentStyle={content}
              presetsStyle={calendarLook.presets}
              presetStyle={calendarLook.preset}
              presetClass={calendarLook.presetClass}
              renderItem={(item) => <CalendarItem item={item} />}
              {...clearProps("Clear the deadline")}
              trigger={<DateTrigger title={due() ? dayTitle(due()!) : "None"} open={open()} placeholder={!due()} clearable={due() !== null} />}
            />
          </View>
          <View style={row(false)}>
            <RowLabel label="Sprint start" detail="Locked once the sprint began" />
            <DatePicker value={iso(addDays(today, -9))} disabled accessibilityLabel="Sprint start" trigger={<DateTrigger title={dayTitle(iso(addDays(today, -9)))} open={false} disabled />} />
          </View>
        </View>
      </Card>
    );
  }

  function Slots() {
    const today = new Date();
    const first = iso(today);
    // From tomorrow, on weekdays.
    const closed: DateMatcher = (date) => date <= first || weekday(date) === 0 || weekday(date) === 6;
    let soonest = addDays(today, 1);
    while (soonest.getDay() === 0 || soonest.getDay() === 6) soonest = addDays(soonest, 1);
    const day = signal<string | null>(iso(soonest));
    const slot = signal<string | null>(null);
    const open = signal(false);
    // A new day's times settle in.
    const t = settleOn(day);
    const free = () => (day() ? SLOTS.filter((_, i) => !slotTaken(day()!, i)).length : 0);
    /** A time's chip: raised while free, in the accent while chosen (faded), struck through while taken. */
    const chip = (on: boolean) => ({
      // A terminal's chips are as wide as their text, two Cells apart.
      width: terminal ? undefined : pointer ? 62 : ("31.5%" as const),
      height: pointer ? 30 : 40,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      borderRadius: radius.control,
      borderWidth: 1,
      borderColor: on ? colors.accent : colors.border,
      backgroundColor: on ? tints.accent : colors.raised,
      boxShadow: on ? "none" : finish.raised.boxShadow,
      transitionProperty: "transform, border-color, background-color, box-shadow",
      transitionDuration: reduceMotion() ? 0 : 150,
    });
    return (
      <Card title="Time slots" subtitle="A weekday, then an open time" right={<Badge label={`${free()} open`} />}>
        <View style={row(true)}>
          <RowLabel label="Day" detail="From tomorrow, on weekdays" />
          <DatePicker
            value={day()}
            onChange={({ value }) => {
              const next = typeof value === "string" ? value : null;
              day.set(next);
              slot.set(null);
              last.set(`Day: ${next ?? "none"}`);
            }}
            onOpenChange={opened((o) => open.set(o))}
            accessibilityLabel="Appointment day"
            disabledMatcher={closed}
            {...calendarProps()}
            renderItem={(item) => <CalendarItem item={item} />}
            trigger={<DateTrigger title={day() ? dayTitle(day()!) : "Pick a day"} open={open()} placeholder={!day()} />}
          />
        </View>
        <View style={settle(t)}>
          <RadioGroup accessibilityLabel="Appointment time" style={{ flexDirection: "row", flexWrap: "wrap", gap: terminal ? TERMINAL_GAP : 6, justifyContent: pointer ? "flex-start" : "space-between" }}>
            <Each of={SLOTS}>
              {(s, i) => (
                <Radio
                  checked={slot() === s()}
                  disabled={!day() || slotTaken(day()!, i())}
                  onChange={() => {
                    sound("select");
                    slot.set(s());
                    last.set(`Slot: ${day()} ${s()}`);
                  }}
                  style={chip(slot() === s())}
                  activeStyle={{ transform: [{ scale: 0.95 }] }}
                  hoverStyle={slot() === s() ? undefined : { borderColor: colors.faint }}
                  focusVisibleStyle={focusRing()}
                  disabledStyle={{ opacity: 0.5 }}
                >
                  <Text
                    style={{
                      fontSize: size.detail,
                      fontWeight: "500",
                      fontVariant: ["tabular-nums"],
                      color: slot() === s() ? colors.accent : colors.text,
                      textDecorationLine: day() && slotTaken(day()!, i()) ? "line-through" : "none",
                    }}
                  >
                    {s()}
                  </Text>
                </Radio>
              )}
            </Each>
          </RadioGroup>
        </View>
        <View style={{ alignItems: pointer ? "flex-end" : "stretch" }}>
          <Button
            label={slot() && day() ? `Book ${dayTitle(day()!)} at ${slot()}` : "Pick a time"}
            size="regular"
            disabled={!slot() || !day()}
            onPress={() => last.set(`Booked: ${dayTitle(day()!)} at ${slot()}`)}
          />
        </View>
      </Card>
    );
  }

  /** The always-visible row that flips a section: the app's trigger, which tells screen readers whether it is expanded. */
  function Summary(props: { label: string; detail?: string; open: boolean; set: (open: boolean) => void; first?: boolean; accordion?: boolean }) {
    return (
      <View
        role="button"
        accessibilityState={{ expanded: props.open }}
        onPress={() => {
          const next = !props.open;
          props.set(next);
          last.set(`${props.label}: ${next ? "expanded" : "collapsed"}`);
        }}
        {...disclosureTriggerLook({ first: props.first })}
      >
        <RowDivider show={!props.first} />
        <RowLabel label={props.label} detail={props.detail} />
        {/* A lane as wide as the chevron's stroke, so the chevron ends where the values below it end;
            an accordion's turns over as the Accordion demo's does. */}
        <DisclosureChevron open={props.open} accordion={props.accordion} />
      </View>
    );
  }
  function Disclosure() {
    const storage = signal(false);
    const advanced = signal(false);
    const originals = signal(false);
    const look = switchLook(() => originals(), size.switch);
    // The content settles in as a section opens (the collapsible adds it
    // then, and takes it out at once as it closes).
    const storageIn = follow(() => (storage() ? 1 : 0));
    const advancedIn = follow(() => (advanced() ? 1 : 0));
    return (
      <Card icon="controls" title="Collapsible" subtitle="Details under a summary, kept while collapsed">
        <View>
          <Collapsible
            open={storage()}
            content={
              <View style={{ ...settle(storageIn), paddingStart: size.gap, paddingBottom: size.padding }}>
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
              <View style={settle(advancedIn)}>
                <Switch
                  checked={originals()}
                  onChange={({ checked: on }) => {
                    originals.set(on);
                    last.set(`Keep originals: ${on ? "on" : "off"}`);
                  }}
                  {...listRow({ start: size.gap, style: { flexDirection: "row-reverse" } })}
                  trackClass={look.trackClass}
          trackStyle={look.trackStyle}
                  thumbStyle={look.thumbStyle}
                >
                  <RowDivider show />
                  <RowLabel label="Keep originals" detail={originals() ? "Edits are saved as copies" : "Edits replace the photo"} />
                </Switch>
              </View>
            }
          >
            <Summary label="Advanced" detail="Options most people leave alone" open={advanced()} set={(open) => advanced.set(open)} />
          </Collapsible>
        </View>
      </Card>
    );
  }

  function Faq() {
    // One answer open at a time, as an accordion: opening one closes the last.
    const open = signal<string | null>(FAQ[0].q);
    function Item(props: { q: string; a: string; first: boolean }) {
      const t = follow(() => (open() === props.q ? 1 : 0));
      return (
        <Collapsible
          open={open() === props.q}
          content={
            // A terminal's answer lines up under the question, past its
            // two-column mark (a box of text takes one column of padding).
            <View style={{ ...settle(t), paddingBottom: size.padding + 4, paddingEnd: 24, flexDirection: terminal ? "row" : undefined }}>
              <If when={terminal}>
                <View style={{ width: 2 * TERMINAL_COLUMN, flexShrink: 0 }} />
              </If>
              <Text style={{ flex: terminal ? 1 : undefined, fontSize: size.label, lineHeight: Math.round(size.label * 1.5), color: colors.muted }}>{props.a}</Text>
            </View>
          }
        >
          <Summary first={props.first} accordion label={props.q} detail="" open={open() === props.q} set={(next) => open.set(next ? props.q : null)} />
        </Collapsible>
      );
    }
    return (
      <Card title="Accordion" subtitle="Questions: one answer open at a time">
        <View>
          <Each of={FAQ}>{(f, i) => <Item q={f().q} a={f().a} first={i() === 0} />}</Each>
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
    // The indeterminate bar's sweep: a third of the track crossing it and
    // back, looped natively; it rests in the middle with reduced motion.
    const sweep = progressSweep();
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
          // The track spans the bar: the sweep crosses two thirds of it.
          onLayout={props.indeterminate ? sweep.onLayout : undefined}
          // The label row first: the children follow the track.
          style={{ ...row(!!props.first), flexDirection: "column-reverse", alignItems: "stretch", gap: size.padding }}
          // The slider's rail and fill, so a level and a transfer read alike;
          // determinate, the fill glides to each new value.
          {...progressLook(() => props.value, { indeterminate: () => props.indeterminate, sweep })}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: size.gap }}>
            <RowLabel label={props.label} detail={props.detail} />
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

  function Uploads() {
    const sent = signal(FILES.map(() => 0));
    const running = signal(false);
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      running.set(false);
    };
    cleanup(stop);
    const all = () => sent().every((v) => v >= 100);
    const start = () => {
      sent.set(FILES.map(() => 0));
      running.set(true);
      last.set("Uploads: started");
      // Each file at its own pace.
      timer = setInterval(() => {
        sent.set(sent().map((v, i) => Math.min(100, v + FILES[i].pace)));
        if (all()) {
          stop();
          last.set("Uploads: done");
        }
      }, 200);
    };
    /** A file: its name and size over a thin bar; its value turns into a check that pops in once it is sent. */
    function File(props: { name: string; size: string; icon: "photos" | "media" | "document"; value: number; first: boolean }) {
      const done = follow(() => (props.value >= 100 ? 1 : 0));
      const away = done.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
      const pop = popOn(() => props.value >= 100);
      return (
        <Progress
          value={props.value}
          style={{ ...row(props.first), flexDirection: "column-reverse", alignItems: "stretch", gap: size.padding }}
          {...progressLook(() => props.value, { height: 4, tone: () => (props.value >= 100 ? "up" : undefined) })}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: size.gap }}>
            <Icon name={props.icon} size={size.control} tint={colors.muted} />
            <RowLabel label={props.name} detail={props.size} width={labelColumn(FILES.map((f) => f.name))} />
            <View style={{ width: 40, height: 20, alignItems: "flex-end", justifyContent: "center" }}>
              <View style={{ ...centered, alignItems: "flex-end", opacity: away }}>
                <Text style={{ fontSize: size.detail, color: colors.muted, fontVariant: ["tabular-nums"] }}>{`${props.value}%`}</Text>
              </View>
              <View style={{ ...centered, left: undefined, width: 20, opacity: done, transform: [{ scale: done.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }) }, { scale: pop }] }}>
                <Icon name="check" size={size.check + 2} tint={toneColor("up")} weight={MARK_WEIGHT} />
              </View>
            </View>
          </View>
        </Progress>
      );
    }
    return (
      <Card title="Several files" subtitle="Each at its own pace, checked when sent" right={<Badge label={`${sent().filter((v) => v >= 100).length} of ${FILES.length}`} tone={all() ? "up" : "neutral"} />}>
        <View>
          <Each of={FILES}>{(f, i) => <File name={f().name} size={f().size} icon={f().icon} value={sent()[i()]} first={i() === 0} />}</Each>
        </View>
        <View style={{ flexDirection: "row", marginTop: size.padding, alignSelf: pointer ? "flex-start" : "stretch" }}>
          <Button
            label={running() ? "Uploading…" : all() ? "Upload again" : "Upload all"}
            size={size.switch}
            flex={pointer ? undefined : 1}
            disabled={running()}
            onPress={start}
          />
        </View>
      </Card>
    );
  }

  function Steps() {
    // 0 to 3: the step shown; 4: all done.
    const step = signal(1);
    const value = () => (Math.min(step(), STEPS.length - 1) / (STEPS.length - 1)) * 100;
    const DOT = 18;
    /** A step's dot: a ring around the current one, citrus with a check once done (a spring each), popping as it is reached. */
    function StepDot(props: { done: boolean; current: boolean }) {
      const done = follow(() => (props.done ? 1 : 0));
      const current = follow(() => (props.current ? 1 : 0));
      const pop = popOn(() => props.current);
      return (
        <View
          class="transition-colors duration-150 motion-reduce:transition-none"
          style={{
            width: DOT,
            height: DOT,
            borderRadius: DOT / 2,
            alignItems: "center",
            justifyContent: "center",
            borderWidth: 1,
            ...choiceWell(),
            borderColor: props.current ? colors.accent : colors.fieldBorder,
            transform: [{ scale: pop }],
          }}
        >
          <ChoiceLight on={done} radius={DOT / 2} />
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent, opacity: current }} />
          <View style={{ ...centered, opacity: done }}>
            <Icon name="check" size={10} tint={colors.onAccent} weight={MARK_WEIGHT} />
          </View>
        </View>
      );
    }
    return (
      <Card title="Steps" subtitle="The bar fills to the step you are on" right={<Badge label={step() >= STEPS.length ? "Done" : `Step ${step() + 1} of ${STEPS.length}`} tone={step() >= STEPS.length ? "up" : "neutral"} />}>
        {/* The bar runs from the first dot's middle to the last's; each label is centered under its dot
            (a terminal's first and last start and end at theirs, off the card's border). */}
        <View style={{ height: DOT + 24, marginHorizontal: 24 }}>
          <View style={{ position: "absolute", left: DOT / 2, right: DOT / 2, top: (DOT - 4) / 2 }}>
            <Progress value={value()} accessibilityLabel="Setup" {...progressLook(() => value(), { height: 4 })} />
          </View>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Each of={STEPS}>
              {(name, i) => (
                <View style={{ width: DOT }}>
                  {/* A terminal shows the steps by their labels: a dot would sit on the bar's row. */}
                  <If when={!terminal}>
                    <StepDot done={i() < step()} current={i() === step()} />
                  </If>
                  <View
                    style={
                      terminal && i() === 0
                        ? { position: "absolute", top: DOT + 6, left: 0, width: 64, alignItems: "flex-start" }
                        : terminal && i() === STEPS.length - 1
                          ? { position: "absolute", top: DOT + 6, right: 0, width: 64, alignItems: "flex-end" }
                          : { position: "absolute", top: DOT + 6, left: (DOT - 64) / 2, width: 64, alignItems: "center" }
                    }
                  >
                    <Text style={{ fontSize: 12, fontWeight: i() === step() ? "600" : "400", color: i() <= step() ? colors.text : colors.faint }}>{name()}</Text>
                  </View>
                </View>
              )}
            </Each>
          </View>
        </View>
        <View style={{ flexDirection: "row", gap: size.gap, marginTop: size.padding, alignSelf: pointer ? "flex-start" : "stretch" }}>
          <Button
            label="Previous step"
            variant="secondary"
            size={size.switch}
            flex={pointer ? undefined : 1}
            disabled={step() === 0}
            onPress={() => {
              step.set(Math.min(step(), STEPS.length) - 1);
              last.set(`Setup: ${STEPS[step()]}`);
            }}
          />
          <Button
            label={step() < STEPS.length - 1 ? "Next step" : step() === STEPS.length - 1 ? "Finish" : "Start over"}
            size={size.switch}
            flex={pointer ? undefined : 1}
            onPress={() => {
              step.set(step() >= STEPS.length ? 0 : step() + 1);
              last.set(step() >= STEPS.length ? "Setup: done" : `Setup: ${STEPS[step()]}`);
            }}
          />
        </View>
      </Card>
    );
  }

  function Meters() {
    const values = signal([14, 92, 60]);
    /** A meter's tone by its value: low battery red, a full disk amber. */
    const tone = (i: number, v: number): Tone | undefined => (i === 0 && v < 20 ? "danger" : i === 1 && v > 85 ? "warn" : undefined);
    return (
      <Card title="Sizes and tones" subtitle="Thin, regular and thick; a tone when it matters">
        <View style={{ gap: size.gap + 4 }}>
          <Each of={METERS}>
            {(m, i) => (
              <Progress
                value={values()[i()]}
                accessibilityLabel={m().name}
                style={{ flexDirection: "column-reverse", alignItems: "stretch", gap: 6 }}
                {...progressLook(() => values()[i()], { height: m().height, tone: () => tone(i(), values()[i()]) })}
              >
                <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
                  <Text style={{ flex: 1, fontSize: size.label, color: colors.text }}>{m().name}</Text>
                  <Text
                    style={{ fontSize: size.detail, color: tone(i(), values()[i()]) ? toneColor(tone(i(), values()[i()])!) : colors.muted, fontVariant: ["tabular-nums"] }}
                  >
                    {m().note(values()[i()])}
                  </Text>
                </View>
              </Progress>
            )}
          </Each>
        </View>
        <View style={{ flexDirection: "row", marginTop: size.padding, alignSelf: pointer ? "flex-start" : "stretch" }}>
          <Button
            label="Shuffle"
            variant="secondary"
            size={size.switch}
            flex={pointer ? undefined : 1}
            onPress={() => {
              values.set(values().map(() => Math.round(5 + Math.random() * 93)));
              last.set(`Meters: ${values().join(", ")}`);
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
            <RowLabel label={props.label} detail={props.detail} />
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
          <Level first label="Volume" detail={muted() ? "Muted" : "Media and alerts"} value={muted() ? "—" : `${volume()}%`}>
            {/* Quieter and louder at the ends; the louder one lights up near the top. */}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, opacity: muted() ? 0.35 : 1 }}>
              <Icon name="volume-low" size={size.control} tint={colors.muted} />
              <Slider
                value={volume()}
                step={5}
                accessibilityLabel="Volume"
                onChange={({ value }) => volume.set(value as number)}
                onChangeEnd={({ value }) => last.set(`Volume: ${value}`)}
                disabled={muted()}
                rangeStyle={sliderFill(0, volume() / 100)}
                {...sliderLook()}
                style={{ flex: 1 }}
              />
              <Icon name="volume-high" size={size.control} tint={volume() >= 80 && !muted() ? colors.accent : colors.muted} />
            </View>
          </Level>
          <Level label="Price" detail={`${listings(price())} listings between the two`} value={`$${price()[0]} – $${price()[1]}`}>
            {/* How many listings each price has: the bars in the range light up as the thumbs move.
                A terminal's two rows would draw them as blank Cells: the count in the label says it. */}
            <If when={!terminal}>
              <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 2, height: 36, paddingHorizontal: pointer ? 7 : 10, marginBottom: -4 }}>
                <Each of={HISTOGRAM}>
                  {(n, i) => (
                    <View
                      class="transition-colors duration-150 motion-reduce:transition-none"
                      style={{
                        flex: 1,
                        height: `${Math.round((n() / HISTOGRAM_MAX) * 100)}%`,
                        minHeight: 2,
                        borderTopLeftRadius: 2,
                        borderTopRightRadius: 2,
                        backgroundColor: inRange(i(), price()) ? chart.s1 : alpha(colors.text, 0.1),
                      }}
                    />
                  )}
                </Each>
              </View>
            </If>
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

  /**
   * A band's well lit from 0 dB, its middle, to its value, so a flat band shows no gain and a cut runs down: the
   * slider's own run, which starts at −12, stays clear.
   */
  const bandWell = (db: number) => {
    const at = ((db + 12) / 24) * 100;
    const [lo, hi] = [Math.min(50, at), Math.max(50, at)];
    const [well, lit] = [colors.track, colors.accentFill];
    return {
      ...sliderLook({ vertical: true }).indicatorStyle,
      backgroundImage: db === 0 ? "none" : `linear-gradient(0deg, ${well} ${lo}%, ${lit} ${lo}%, ${lit} ${hi}%, ${well} ${hi}%)`,
    };
  };
  const clearRun = { backgroundColor: "transparent", backgroundImage: "none", borderWidth: 0 } as const;

  function Equalizer() {
    const bands = BANDS.map(() => signal(0));
    const preset = signal<"Flat" | "Bass" | "Vocal">("Flat");
    const apply = (name: "Flat" | "Bass" | "Vocal") => {
      preset.set(name);
      PRESETS[name].forEach((v, i) => bands[i].set(v));
      last.set(`Equalizer: ${name}`);
    };
    return (
      <Card title="Vertical" subtitle="Five bands from −12 to +12 dB" right={<Segmented options={EQ_PRESETS} value={preset()} onChange={apply} size="small" />}>
        {/* A terminal's controls are one row each: a band a row, its name, its slider across, its value. */}
        <If when={terminal}>
          <View style={{ gap: 4 }}>
            {BANDS.map((name, i) => (
              <View style={{ flexDirection: "row", alignItems: "center", gap: TERMINAL_GAP }}>
                <Text style={{ width: 3 * TERMINAL_COLUMN, textAlign: "right", fontSize: size.detail, color: colors.muted }}>{name}</Text>
                <Slider
                  value={bands[i]()}
                  min={-12}
                  max={12}
                  accessibilityLabel={`${name} band`}
                  onChange={({ value }) => bands[i].set(value as number)}
                  onChangeEnd={({ value }) => last.set(`${name}: ${value} dB`)}
                  rangeStyle={sliderFill(0, (bands[i]() + 12) / 24)}
                  {...sliderLook()}
                  style={{ flex: 1 }}
                />
                <Text style={{ width: 3 * TERMINAL_COLUMN, textAlign: "right", fontSize: size.detail, color: bands[i]() === 0 ? colors.faint : colors.text, fontVariant: ["tabular-nums"] }}>
                  {`${bands[i]() > 0 ? "+" : ""}${bands[i]()}`}
                </Text>
              </View>
            ))}
          </View>
        </If>
        <If when={!terminal}>
        <View style={{ flexDirection: "row", justifyContent: "space-around", paddingTop: 4 }}>
          {BANDS.map((name, i) => (
            <View style={{ alignItems: "center", gap: 6 }}>
              <Text style={{ fontSize: size.detail, color: bands[i]() === 0 ? colors.faint : colors.text, fontVariant: ["tabular-nums"] }}>
                {`${bands[i]() > 0 ? "+" : ""}${bands[i]()}`}
              </Text>
              <Slider
                value={bands[i]()}
                min={-12}
                max={12}
                axis="vertical"
                accessibilityLabel={`${name} band`}
                onChange={({ value }) => bands[i].set(value as number)}
                onChangeEnd={({ value }) => last.set(`${name}: ${value} dB`)}
                rangeStyle={clearRun}
                {...sliderLook({ vertical: true })}
                indicatorStyle={bandWell(bands[i]())}
              />
              <Text style={{ fontSize: size.detail, color: colors.muted }}>{name}</Text>
            </View>
          ))}
        </View>
        </If>
      </Card>
    );
  }

  // The number inputs' look is the shared one (`numberInputClasses`, `numberInputSteps`, `numberInputText`): one
  // recessed well per input, the fields' focus edge while its field edits, buttons lit under the pointer and faded
  // where a step does nothing; in a terminal one band a row high, the steppers at its end.
  const frame = numberInputClasses.frame;
  const steps = numberInputSteps;
  const field = numberInputText;
  /** The field's own spacing besides {@link field}'s. A terminal's field keeps {@link field}'s column before its value and none after it: the caret's column is the column after the value. */
  const spaced = (style: { paddingLeft?: number; paddingRight?: number; paddingHorizontal?: number }) => (terminal ? { paddingRight: 0 } : style);
  /** Centered between its steppers, but at the end in a terminal (as {@link field}). */
  const stepAlign = terminal ? ("right" as const) : ("center" as const);
  /** A quantity: its label and the input at the trailing edge. */
  function Amount(props: { label: string; detail: JSX.Element; first?: boolean; children: JSX.Element }) {
    return (
      <View style={row(!!props.first)}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ fontSize: size.label, color: colors.text }}>{props.label}</Text>
          {props.detail}
        </View>
        <View style={{ width: terminal ? 18 * TERMINAL_COLUMN : pointer ? 132 : 152 }}>{props.children}</View>
      </View>
    );
  }
  /** A quieter line under an amount's label. */
  function Detail(props: { children: JSX.Element; tone?: Tone }) {
    return <Text style={{ fontSize: size.detail, color: props.tone ? toneColor(props.tone) : colors.muted }}>{props.children}</Text>;
  }
  /** A unit or a currency in a number input's well, before or after its field. */
  function Affix(props: { label: string; end?: boolean }) {
    return (
      <View
        style={
          terminal
            ? // A prefix at the band's start; a suffix after the field's caret column, after the value, as wide as the
              // widest (three Cells); the steppers' slots keep their own blank Cell after it.
              props.end
              ? { justifyContent: "center", width: 3 * TERMINAL_COLUMN }
              : { justifyContent: "center" }
            : { height: "100%", justifyContent: "center", paddingLeft: props.end ? 0 : 10, paddingRight: props.end ? 8 : 0 }
        }
      >
        <Text style={{ fontSize: size.label, color: colors.muted, transform: [{ translateY: -1 }] }}>{props.label}</Text>
      </View>
    );
  }

  function Quantities() {
    const seats = signal<number | null>(2);
    const price = signal<number | null>(24.5);
    const locked = signal(false);
    const show = (v: number | null) => (v === null ? "none" : `${v}`);
    return (
      <Card icon="controls" title="Number input" subtitle="Typed or stepped: the app owns the value">
        <View>
          <Amount first label="Seats" detail={<Detail>1 to 8 per booking</Detail>}>
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
              inputStyle={{ ...field(), ...spaced({}), textAlign: stepAlign }}
              {...steps("split", pointer ? "w-8" : "w-11", pointer ? 14 : 16)}
            />
          </Amount>
          <Amount label="Price" detail={<Detail>Steps of 0.5</Detail>}>
            <NumberInput
              value={price()}
              min={0}
              step={0.5}
              placeholder="Free"
              accessibilityLabel="Price"
              onChange={({ value: next }) => {
                price.set(next);
                last.set(`Price: ${show(next)}`);
              }}
              class={frame}
              inputStyle={{ ...field(), ...spaced({ paddingLeft: 4 }) }}
              {...steps("pair", pointer ? "w-6" : "w-9", pointer ? 14 : 16)}
              prefix={<Affix label="$" />}
            />
          </Amount>
        </View>
        <View style={{ flexDirection: "row", gap: size.gap, marginTop: size.padding, alignSelf: pointer ? "flex-start" : "stretch" }}>
          <Button
            label={locked() ? "Unlock seats" : "Lock seats"}
            variant="secondary"
            size="regular"
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

  function Cart() {
    const qty = signal<(number | null)[]>([1, 2, 3]);
    const subtotal = () => CART.reduce((n, c, i) => n + c.price * (qty()[i] ?? 0), 0);
    const toFree = () => Math.max(0, FREE_SHIPPING - subtotal());
    const shipping = () => (toFree() === 0 ? 0 : 8);
    const pop = popOn(() => toFree() === 0);
    const reached = () => Math.min(100, (subtotal() / FREE_SHIPPING) * 100);
    /** A line of the cart: the item, a compact stepper held to the stock, and its subtotal rolling to each new value. */
    function Line(props: { i: number; first: boolean }) {
      const item = CART[props.i];
      const n = () => qty()[props.i];
      const atStock = () => n() !== null && n()! >= item.stock;
      return (
        <View style={row(props.first)}>
          <If when={pointer}>
            <IconTile name={item.icon} size={30} tint={colors.muted} />
          </If>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text style={{ numberOfLines: 1, fontSize: size.label, color: colors.text }}>{item.name}</Text>
            <Message label={atStock() ? `Only ${item.stock} left` : `${item.detail} · ${money(item.price)}`} tone={atStock() ? "warn" : undefined} />
          </View>
          <View style={{ width: terminal ? 13 * TERMINAL_COLUMN : pointer ? 92 : 108 }}>
            <NumberInput
              value={n()}
              min={1}
              max={item.stock}
              accessibilityLabel={`Quantity of ${item.name}`}
              onChange={({ value }) => {
                const next = qty().slice();
                next[props.i] = value;
                qty.set(next);
                last.set(`${item.name}: ${value ?? "none"}`);
              }}
              class={frame}
              inputStyle={{ ...field(), ...spaced({ paddingHorizontal: 2 }), textAlign: stepAlign }}
              {...steps("split", pointer ? "w-7" : "w-9", pointer ? 12 : 14)}
            />
          </View>
          <View style={{ width: pointer ? 64 : 70 }}>
            <Ticker value={item.price * (n() ?? 0)} text={money(item.price * (n() ?? 0))} />
          </View>
        </View>
      );
    }
    return (
      <Card title="Cart" subtitle="Held to the stock; totals roll to new values" right={<Badge label={`${qty().reduce<number>((a, b) => a + (b ?? 0), 0)} items`} />}>
        <View>
          <Each of={CART}>{(_, i) => <Line i={i()} first={i() === 0} />}</Each>
        </View>
        <View style={{ gap: 6 }}>
          <Progress
            value={reached()}
            accessibilityLabel="Toward free shipping"
            {...progressLook(() => reached(), { height: 4, tone: () => (toFree() === 0 ? "up" : undefined) })}
          />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <If when={toFree() === 0}>
              <View style={{ transform: [{ scale: pop }] }}>
                <Icon name="check" size={size.check} tint={toneColor("up")} weight={MARK_WEIGHT} />
              </View>
            </If>
            <Message label={toFree() === 0 ? "Free shipping unlocked" : `Add ${money(toFree())} more for free shipping`} tone={toFree() === 0 ? "up" : undefined} />
          </View>
        </View>
        <View style={{ gap: 6, paddingTop: size.padding, borderTopWidth: 1, borderColor: colors.line }}>
          <BillLine label="Subtotal" amount={subtotal()} />
          <BillLine label="Shipping" amount={shipping()} />
          <BillLine label="Total" amount={subtotal() + shipping()} total />
        </View>
      </Card>
    );
  }

  function Units() {
    const tip = signal<number | null>(15);
    const amount = signal<number | null>(250);
    const heat = signal<number | null>(21.5);
    const BALANCE = 1200;
    const over = () => (amount() ?? 0) > BALANCE;
    const tipped = () => (BILL * (tip() ?? 0)) / 100;
    /** How the room feels at the set temperature, and its tone. */
    const feel = (): { label: string; tone: Tone } => {
      const c = heat() ?? 21;
      return c < 19 ? { label: "Cool", tone: "info" } : c <= 24 ? { label: "Comfortable", tone: "up" } : { label: "Warm", tone: "warn" };
    };
    /** The buttons at the well's end, the increment over the decrement (new glyphs for each input). */
    const right = () => steps("pair", pointer ? "w-6" : "w-9", pointer ? 14 : 16);
    return (
      <Card title="Units and limits" subtitle="A percentage, a currency, half degrees, a rate">
        <View>
          <Amount
            first
            label="Tip"
            detail={
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <Ticker value={tipped()} text={money(tipped())} size={size.detail} weight="600" color={colors.muted} />
                <Detail>{`on a ${money(BILL)} bill`}</Detail>
              </View>
            }
          >
            <NumberInput
              value={tip()}
              min={0}
              max={30}
              step={5}
              accessibilityLabel="Tip"
              onChange={({ value }) => {
                tip.set(value);
                last.set(`Tip: ${value ?? "none"}%`);
              }}
              class={frame}
              inputStyle={{ ...field(), textAlign: "right", ...spaced({ paddingRight: 2 }) }}
              suffix={<Affix label="%" end />}
              {...right()}
            />
          </Amount>
          <Amount label="Transfer" detail={<Message label={over() ? `More than your balance of ${money(BALANCE)}` : "$10 to $5,000, in steps of $50"} tone={over() ? "danger" : undefined} />}>
            <NumberInput
              value={amount()}
              min={10}
              max={5000}
              step={50}
              placeholder="0"
              accessibilityLabel="Transfer amount"
              onChange={({ value }) => {
                amount.set(value);
                last.set(`Transfer: ${value ?? "none"}`);
              }}
              class={frame}
              // Over the balance, the well is edged in the danger tone.
              style={over() ? { borderColor: colors.danger } : undefined}
              inputStyle={{ ...field(), ...spaced({ paddingLeft: 4, paddingRight: 2 }) }}
              prefix={<Affix label="$" />}
              suffix={<Affix label="USD" end />}
              {...right()}
            />
          </Amount>
          <Amount
            label="Thermostat"
            detail={
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Dot color={toneColor(feel().tone)} size={6} />
                <Message label={`${feel().label}, 16 to 28 °C`} />
              </View>
            }
          >
            <NumberInput
              value={heat()}
              min={16}
              max={28}
              step={0.5}
              accessibilityLabel="Thermostat"
              onChange={({ value }) => {
                heat.set(value);
                last.set(`Thermostat: ${value ?? "none"}`);
              }}
              class={frame}
              inputStyle={{ ...field(), textAlign: "right", ...spaced({ paddingRight: 2 }) }}
              suffix={<Affix label="°C" end />}
              {...right()}
            />
          </Amount>
          <Amount label="Interest rate" detail={<Detail>Set by your bank: select and copy it</Detail>}>
            <NumberInput
              value={4.5}
              readonly
              accessibilityLabel="Interest rate"
              class={frame}
              inputStyle={{ ...field(), textAlign: "right", ...spaced({ paddingRight: 2 }) }}
              suffix={<Affix label="%" end />}
              {...right()}
            />
          </Amount>
        </View>
      </Card>
    );
  }

  // The codes' cells, shared by their cards: recessed wells, the one that
  // takes the next digit ringed while the code has the focus, its caret
  // blinking there (steady with reduced motion: the input's own). A cell
  // that holds a digit (a bullet too) lifts out of its well, a card's fill
  // under a firmer edge (`data-filled:`). A verdict edges and tints them
  // all in its tone, over that; each change fades (`transition-colors`).
  //
  // In a terminal a cell is a framed box, three rows high and three Cells inside, its digit in the middle: its line
  // only, no fill. The cell that takes the next digit has its line in the accent, a verdict's tone edges them all, a
  // disabled code dims.
  /** The codes' groups: three Cells apart in a terminal (a Cell's gap and a Cell of margin each side), their cells one. */
  const codeClass = terminal ? "flex-row items-center gap-2" : "flex-row items-center gap-3";
  const groupClass = terminal ? "flex-row gap-2 mx-2" : "flex-row gap-1.5";
  /**
   * A blank row between a code's framed cells and the caption above or the message below them in a terminal (a
   * card's gaps take no row there: its border sets its content apart).
   */
  const CodeSpace = () => (
    <If when={terminal}>
      <View style={{ height: TERMINAL_ROW }} />
    </If>
  );
  const sixCells = otpCells;

  function Verify() {
    const CODE = "246810";
    const code = signal("");
    const verdict = signal("");
    // A wrong code shakes the cells.
    const shake = createMotion();
    cleanup(() => shake.stop());
    const tone = (): Tone | undefined => (verdict() === "Verified" ? "up" : verdict() ? "danger" : undefined);
    return (
      <Card icon="controls" title="One-time code" subtitle={terminal ? "Six digits, typed or pasted; a wrong one marks" : "Six digits, typed or pasted; a wrong one shakes"}>
        <View style={{ alignItems: "center", gap: size.gap, paddingVertical: size.padding }}>
          <View style={shake.style}>
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
                if (value !== CODE && !terminal) shake.play("shake");
                last.set(`Code complete: ${value}`);
              }}
              accessibilityLabel="Verification code, 6 digits"
              class={codeClass}
              groupClass={groupClass}
              {...otpCellLook({ cells: sixCells, tone: () => tone() })}
            />
          </View>
          <CodeSpace />
          <Message label={verdict() || `The code is ${CODE}`} tone={tone()} />
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

  function SignIn() {
    const CODE = "135790";
    /** The seconds before a code can be sent again. */
    const WAIT = 30;
    type Phase = "idle" | "sent" | "checking" | "wrong" | "locked" | "done";
    const phase = signal<Phase>("idle");
    const code = signal("");
    const tries = signal(3);
    const left = signal(0);
    let input: OtpInputRef | undefined;
    let tick: ReturnType<typeof setInterval> | undefined;
    let later: ReturnType<typeof setTimeout> | undefined;
    const stopTick = () => {
      if (tick !== undefined) clearInterval(tick);
      tick = undefined;
    };
    const after = (ms: number, run: () => void) => {
      if (later !== undefined) clearTimeout(later);
      later = setTimeout(() => {
        later = undefined;
        run();
      }, ms);
    };
    cleanup(() => {
      stopTick();
      if (later !== undefined) clearTimeout(later);
    });
    const shake = createMotion();
    cleanup(() => shake.stop());
    const send = () => {
      phase.set("sent");
      code.set("");
      tries.set(3);
      left.set(WAIT);
      stopTick();
      tick = setInterval(() => {
        left.set(left() - 1);
        if (left() <= 0) stopTick();
      }, 1000);
      // Once the cells take input again (the next turn's commit), the keyboard goes to them.
      after(0, () => input?.focus());
      last.set("Sign-in: code sent");
    };
    // The server's answer takes a moment; a wrong code shakes the cells and empties them, the third locks them.
    const verify = (value: string) => {
      phase.set("checking");
      after(600, () => {
        if (value === CODE) {
          stopTick();
          phase.set("done");
          last.set("Sign-in: verified");
          return;
        }
        const rest = tries() - 1;
        tries.set(rest);
        code.set("");
        if (!terminal) shake.play("shake");
        phase.set(rest === 0 ? "locked" : "wrong");
        last.set(rest === 0 ? "Sign-in: locked" : `Sign-in: wrong code, ${rest} left`);
        if (rest > 0) input?.focus();
      });
    };
    const message = (): { label: string; tone?: Tone } => {
      switch (phase()) {
        case "idle":
          return { label: "We will text a code to +1 555 010 2299" };
        case "sent":
          return { label: `Enter the code we sent (${CODE}), or paste it` };
        case "checking":
          return { label: "Checking…" };
        case "wrong":
          return { label: `That code is wrong: ${tries()} ${tries() === 1 ? "try" : "tries"} left`, tone: "danger" };
        case "locked":
          return { label: "Too many tries: send a new code", tone: "danger" };
        case "done":
          return { label: "Signed in", tone: "up" };
      }
    };
    const tone = (): Tone | undefined => (phase() === "wrong" || phase() === "locked" ? "danger" : phase() === "done" ? "up" : undefined);
    const waiting = () => (phase() === "sent" || phase() === "wrong") && left() > 0;
    /** The check that pops in once signed in. */
    function Signed() {
      const m = createMotion({ enter: "popIn" });
      cleanup(() => m.stop());
      return (
        <View style={{ width: 20, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: tints.up, ...m.style }}>
          <Icon name="check" size={12} tint={toneColor("up")} weight={MARK_WEIGHT} />
        </View>
      );
    }
    return (
      <Card title="Sign in" subtitle={terminal ? "Send, wait to resend; three wrong codes lock it" : "Send, wait to resend; three wrong codes lock it"}>
        <View style={{ alignItems: "center", gap: size.gap, paddingVertical: size.padding }}>
          <View style={shake.style}>
            <OtpInput
              ref={(r) => (input = r)}
              length={6}
              groups={2}
              value={code()}
              disabled={phase() !== "sent" && phase() !== "wrong"}
              onChange={({ value }) => {
                code.set(value);
                if (phase() === "wrong") phase.set("sent");
              }}
              onComplete={({ value }) => {
                last.set(`Sign-in code: ${value}`);
                verify(value);
              }}
              accessibilityLabel="Sign-in code, 6 digits"
              class={codeClass}
              groupClass={groupClass}
              {...otpCellLook({ cells: sixCells, tone: () => tone() })}
            />
          </View>
          <CodeSpace />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <If when={phase() === "done"}>
              <Signed />
            </If>
            <Message label={message().label} tone={message().tone} />
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: pointer ? 28 : 36 }}>
            <If when={phase() === "idle"}>
              <Button label="Send code" size={size.switch} onPress={send} />
            </If>
            <If when={waiting()}>
              <Text style={{ fontSize: size.detail, color: colors.muted }}>Resend code in</Text>
              <Ticker value={left()} text={`0:${String(left()).padStart(2, "0")}`} size={size.detail} color={colors.muted} />
            </If>
            <If when={phase() === "locked" || ((phase() === "sent" || phase() === "wrong") && left() <= 0)}>
              <Button label="Resend code" variant="secondary" size={size.switch} onPress={send} />
            </If>
            <If when={phase() === "done"}>
              <Button
                label="Sign out"
                variant="secondary"
                size={size.switch}
                onPress={() => {
                  phase.set("idle");
                  code.set("");
                  last.set("Sign-in: signed out");
                }}
              />
            </If>
          </View>
        </View>
      </Card>
    );
  }

  function Pin() {
    type PinStep = "choose" | "confirm" | "mismatch" | "set";
    const pin = signal("");
    const step = signal<PinStep>("choose");
    const shown = signal(false);
    let chosen = "";
    const shake = createMotion();
    cleanup(() => shake.stop());
    const message = (): { label: string; tone?: Tone } =>
      step() === "choose"
        ? { label: "Choose a 4-digit PIN" }
        : step() === "confirm"
          ? { label: "Enter it again" }
          : step() === "mismatch"
            ? { label: "The PINs do not match: choose one again", tone: "danger" }
            : { label: "PIN set", tone: "up" };
    /** How far along: a bar for each of the two entries, filled (faded) once it is behind. */
    const done = () => (step() === "confirm" ? 1 : step() === "set" ? 2 : 0);
    const pinCells = pointer ? "w-11 h-11 text-xl" : "w-13 h-13 text-2xl";
    return (
      <Card title="PIN" subtitle={terminal ? "Entered twice; a mismatch starts over" : "Entered twice; a mismatch shakes"} right={<Badge label={step() === "set" ? "Set" : `Step ${done() + 1} of 2`} tone={step() === "set" ? "up" : "neutral"} />}>
        <View style={{ alignItems: "center", gap: size.gap, paddingVertical: size.padding }}>
          {/* The steps' bars; a terminal shows the step in the badge alone. */}
          <View style={{ flexDirection: "row", gap: 6, display: terminal ? "none" : "flex" }}>
            <Each of={[0, 1]}>
              {(i) => (
                <View
                  style={{
                    width: 28,
                    height: 4,
                    borderRadius: 2,
                    // Done steps filled; the one being entered half lit.
                    backgroundColor: done() > i() ? colors.accent : done() === i() && step() !== "set" ? alpha(colors.accent, 0.4) : alpha(colors.text, 0.1),
                    transitionProperty: "background-color",
                    transitionDuration: reduceMotion() ? 0 : 200,
                  }}
                />
              )}
            </Each>
          </View>
          <Message label={message().label} tone={message().tone} />
          <CodeSpace />
          <View style={shake.style}>
            <OtpInput
              length={4}
              masked={!shown()}
              value={pin()}
              disabled={step() === "set"}
              onChange={({ value }) => pin.set(value)}
              onComplete={({ value }) => {
                pin.set("");
                if (step() !== "confirm") {
                  chosen = value;
                  step.set("confirm");
                  last.set("PIN: entered once");
                } else if (value === chosen) {
                  step.set("set");
                  last.set("PIN: set");
                } else {
                  if (!terminal) shake.play("shake");
                  step.set("mismatch");
                  last.set("PIN: no match");
                }
              }}
              accessibilityLabel="PIN, 4 digits"
              class="flex-row items-center gap-2"
              groupClass="flex-row gap-2"
              {...otpCellLook({ cells: pinCells, tone: () => step() === "mismatch" ? "danger" : step() === "set" ? "up" : undefined })}
            />
          </View>
          <CodeSpace />
          <View style={{ flexDirection: "row", gap: size.gap }}>
            <Button
              label={shown() ? "Hide digits" : "Show digits"}
              variant="ghost"
              size={size.switch}
              onPress={() => {
                shown.set(!shown());
                last.set(`PIN: digits ${shown() ? "shown" : "hidden"}`);
              }}
            />
            <If when={step() === "set"}>
              <Button
                label="Change PIN"
                variant="secondary"
                size={size.switch}
                onPress={() => {
                  step.set("choose");
                  chosen = "";
                  last.set("PIN: change");
                }}
              />
            </If>
          </View>
        </View>
      </Card>
    );
  }

  function Last() {
    return (
      <Card icon="system" title="Last event">
        <LastEvent value={last()} hint="Change a control" />
      </Card>
    );
  }

  const cards: Record<Control, (() => JSX.Element)[]> = {
    Switch: [Settings, Quick],
    Checkbox: [Filter, Checklist, Consent, Channels, BoxStates],
    Radio: [Plans, Delivery, Reading],
    Tabs: [Sections, Project],
    Select: [Choices, Downloads, Shipping, Issue],
    Combobox: [Tags, People, Labels, Commands],
    DatePicker: [Dates, Booking, Deadline, Slots],
    Collapsible: [Disclosure, Faq],
    Progress: [Transfers, Uploads, Steps, Meters],
    Slider: [Levels, Equalizer],
    NumberInput: [Quantities, Cart, Units],
    OtpInput: [Verify, SignIn, Pin],
  };
  // `firsts`: the first card of each named control on one page, above one last event (the TUI host's acceptance tests).
  const shown = props.firsts ? props.firsts.map((control) => cards[control][0]) : cards[props.show];
  return <DemoPage cards={[...shown, Last]} />;
}

export const SwitchDemo = () => <Controls show="Switch" />;
export const CheckboxDemo = () => <Controls show="Checkbox" />;
export const RadioDemo = () => <Controls show="Radio" />;
export const TabsDemo = () => <Controls show="Tabs" />;
export const SelectDemo = () => <Controls show="Select" />;
export const ComboboxDemo = () => <Controls show="Combobox" />;
export const DatePickerDemo = () => <Controls show="DatePicker" />;
export const CollapsibleDemo = () => <Controls show="Collapsible" />;
export const ProgressDemo = () => <Controls show="Progress" />;
export const SliderDemo = () => <Controls show="Slider" />;
export const NumberInputDemo = () => <Controls show="NumberInput" />;
export const OtpInputDemo = () => <Controls show="OtpInput" />;
