import { type JSX, mount, signal, Text, View } from "nsh";
import { Button, type OpenChangeReason, Select, type SelectGroup, type SelectItemState, Switch } from "nsh/base";
import { button, buttonText, desktop, focusRing, hoverFill, Log, Panel, size, Split, tint, ui } from "./palette";

// Two selects in a settings card: a plain one (typeahead jumps by letter)
// and a searchable one with sections, a disabled item and an empty state.
// The trigger is the shared button look (hover, pressed, focus ring,
// disabled) with the chosen title and a chevron that turns while the list
// is open; the list is a popup at the trigger with a pointer, a sheet on a
// touch screen. The highlighted row (the keys or the pointer) is lit with
// the accent tint, the chosen one is bolder with a check in its own lane.

const LANGUAGES = [
  { value: "en", title: "English" },
  { value: "de", title: "Deutsch" },
  { value: "es", title: "Español" },
  { value: "fr", title: "Français" },
  { value: "it", title: "Italiano" },
  { value: "nl", title: "Nederlands" },
  { value: "pl", title: "Polski" },
  { value: "pt", title: "Português" },
  { value: "sv", title: "Svenska" },
  { value: "tr", title: "Türkçe" },
  { value: "ja", title: "日本語" },
  { value: "ko", title: "한국어" },
  { value: "zh", title: "中文" },
];

const REGIONS = [
  { value: "us-east-1", title: "US East (Virginia)", group: "Americas" },
  { value: "us-west-2", title: "US West (Oregon)", group: "Americas" },
  { value: "ca-central-1", title: "Canada (Montréal)", group: "Americas" },
  { value: "sa-east-1", title: "South America (São Paulo)", group: "Americas" },
  { value: "eu-west-1", title: "Europe (Ireland)", group: "Europe" },
  { value: "eu-central-1", title: "Europe (Frankfurt)", group: "Europe" },
  { value: "eu-north-1", title: "Europe (Stockholm)", group: "Europe" },
  { value: "ap-northeast-1", title: "Asia Pacific (Tokyo)", group: "Asia Pacific" },
  { value: "ap-northeast-2", title: "Asia Pacific (Seoul)", group: "Asia Pacific", disabled: true },
  { value: "ap-southeast-1", title: "Asia Pacific (Singapore)", group: "Asia Pacific" },
  { value: "ap-east-1", title: "Asia Pacific (Hong Kong)", group: "Asia Pacific" },
  { value: "ap-southeast-2", title: "Asia Pacific (Sydney)", group: "Asia Pacific" },
];

const titleOf = (items: { value: string; title: string }[], value: string | null) => items.find((i) => i.value === value)?.title;

/** The text of a control: 13 with a pointer, the touch label size otherwise. */
const controlText = desktop ? 13 : size.label;

/** A popup at the trigger with a pointer, a sheet at the bottom on a touch screen. */
const surface = () =>
  desktop
    ? { ...ui().card, borderRadius: 12, padding: 4 }
    : { ...ui().card, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 10, paddingTop: 10, paddingBottom: 30, maxHeight: "70%" as const };

const backdrop = { backgroundColor: "rgba(0,0,0,0.45)" };

/** The trigger: the shared button's look, the chosen title at the start and a chevron in a lane as wide as it. */
function Trigger(props: { title?: string; placeholder: string; open: boolean; disabled?: boolean; clearable?: boolean }) {
  const look = button("secondary", {
    style: () => ({
      flexDirection: "row",
      justifyContent: "space-between",
      gap: 8,
      ...(desktop ? { width: 260 } : {}),
      // Open: the border stays lit while the list is up; disabled, dimmed.
      ...(props.open ? { borderColor: ui().faint } : {}),
      ...(props.disabled ? { opacity: 0.4 } : {}),
    }),
  });
  return (
    // No hover while disabled.
    <View {...look} hoverStyle={props.disabled ? undefined : look.hoverStyle}>
      <Text style={{ numberOfLines: 1, flex: 1, fontSize: controlText, color: props.title ? ui().text : ui().faint }}>
        {props.title ?? props.placeholder}
      </Text>
      {/* With a clear button over the end (`cleanable`), an empty lane as wide as the button in place of the chevron. */}
      <View
        class="transition-transform duration-150 motion-reduce:transition-none"
        style={{
          width: props.clearable ? 20 : 10,
          height: 20,
          alignItems: "center",
          justifyContent: "center",
          opacity: props.clearable ? 0 : 1,
          transform: [{ rotate: props.open ? "270deg" : "90deg" }],
        }}
      >
        <Text style={{ fontSize: 18, color: ui().muted }}>›</Text>
      </View>
    </View>
  );
}

/** A row: the title, a quieter detail at the end, the check in its own lane. */
function Row(props: { item: SelectItemState; detail?: string }) {
  return (
    <View
      style={{
        height: size.rowSm,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: "transparent",
        opacity: props.item.disabled ? 0.4 : 1,
        // Highlighted (the keys or the pointer): the accent tint, as the menus' rows.
        ...(props.item.highlighted ? { backgroundColor: tint(ui().accent, 0.08), borderColor: tint(ui().accent, 0.24) } : {}),
      }}
    >
      <Text style={{ numberOfLines: 1, flex: 1, fontSize: controlText, fontWeight: props.item.selected ? "600" : "400", color: ui().text }}>
        {props.item.title}
      </Text>
      <If when={props.detail}>
        <Text style={{ fontSize: 12, color: ui().faint }}>{props.detail}</Text>
      </If>
      <Text style={{ width: 12, fontSize: 12, textAlign: "right", color: ui().accent }}>{props.item.selected ? "✓" : ""}</Text>
    </View>
  );
}

function Header(props: { group: SelectGroup }) {
  return (
    <Text style={{ fontSize: 12, fontWeight: "500", color: ui().muted, paddingHorizontal: 9, paddingTop: 8, paddingBottom: 4 }}>
      {props.group.title}
    </Text>
  );
}

/** A label over its control, a quieter line under the label. */
function Field(props: { label: string; detail: string; children: JSX.Element }) {
  return (
    <View style={{ gap: 8 }}>
      <View style={{ gap: 2 }}>
        <Text style={{ fontSize: size.label, fontWeight: "500", color: ui().text }}>{props.label}</Text>
        <Text style={{ fontSize: size.detail, color: ui().muted }}>{props.detail}</Text>
      </View>
      {props.children}
    </View>
  );
}

function App() {
  const language = signal<string | null>("en");
  const region = signal<string | null>(null);
  const languageOpen = signal(false);
  const regionOpen = signal(false);
  const locked = signal(false);
  const events = signal<string[]>([]);
  const log = (line: string) => events.set([line, ...events()].slice(0, 8));
  const opened = (name: string, open: (next: boolean) => void) => ({ open: next, reason }: { open: boolean; reason: OpenChangeReason }) => {
    open(next);
    log(`${name} ${next ? "opened" : "closed"} · ${reason}`);
  };
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>select</Text>
      <Text style={{ color: ui().muted }}>
        {desktop ? "Click a select, or Tab to it and press Down; type a letter to jump" : "Tap a select to choose from a sheet"}
      </Text>

      <Split
        gap={14}
        inspector={
          <>
            <Panel title="value">
              <Text style={{ fontSize: 13, color: ui().text, fontVariant: ["tabular-nums"] }}>{`language ${language() ?? "null"}`}</Text>
              <Text style={{ fontSize: 13, color: ui().text, fontVariant: ["tabular-nums"] }}>{`region ${region() ?? "null"}`}</Text>
              <Button
                disabled={region() === null}
                onPress={() => region.set(null)}
                {...button("secondary", { size: "sm", style: { marginTop: 6 } })}
              >
                <Text style={buttonText("secondary", { size: "sm" })}>Clear region</Text>
              </Button>
              <Switch
                checked={locked()}
                onChange={({ checked }) => locked.set(checked)}
                class={`-mx-2 mt-1 flex-row-reverse items-center justify-between gap-3 rounded-lg px-2 ${desktop ? "py-1" : "py-2"} active:opacity-70`}
                hoverStyle={hoverFill()}
                focusStyle={focusRing()}
                trackClass={`${desktop ? "w-9" : "w-12"} rounded-full p-0.5 transition-colors motion-reduce:transition-none`}
                trackStyle={locked() ? ui().accentFill : ui().inset}
                thumbClass={desktop ? "size-4 rounded-full transition-transform motion-reduce:transition-none checked:translate-x-4" : "size-5.5 rounded-full transition-transform motion-reduce:transition-none checked:translate-x-5"}
                thumbStyle={locked() ? { backgroundColor: ui().onAccent } : ui().raised}
              >
                <Text style={{ flex: 1, fontSize: size.label, color: ui().text }}>Region disabled</Text>
              </Switch>
            </Panel>
            <Log title="onChange · onOpenChange" lines={events()} minHeight={120} />
          </>
        }
      >
        <View style={{ ...ui().card, borderRadius: 16, padding: 16, gap: 20 }}>
          <Field label="Language" detail={desktop ? "Typing a letter on the trigger chooses by title" : "Thirteen languages in a sheet"}>
            <Select
              items={LANGUAGES}
              value={language()}
              onChange={({ value: next }) => {
                language.set(next);
                log(`Language → ${titleOf(LANGUAGES, next)}`);
              }}
              onOpenChange={opened("Language", (next) => languageOpen.set(next))}
              accessibilityLabel="Language"
              offset={4}
              margin={8}
              popupStyle={surface()}
              backdropStyle={backdrop}
              itemClass="active:opacity-70"
              trigger={<Trigger title={titleOf(LANGUAGES, language())} placeholder="Choose a language" open={languageOpen()} />}
              renderItem={(item) => <Row item={item} />}
            />
          </Field>
          <Field label="Region" detail="Search by name; one region is at capacity">
            <Select
              items={REGIONS}
              value={region()}
              onChange={({ value: next }) => {
                region.set(next);
                log(next === null ? "Region cleared" : `Region → ${titleOf(REGIONS, next)}`);
              }}
              onOpenChange={opened("Region", (next) => regionOpen.set(next))}
              disabled={locked()}
              accessibilityLabel="Region"
              searchable
              searchPlaceholder="Search regions"
              searchClass={`${desktop ? "text-sm" : "text-base"} placeholder:text-[${ui().faint}] text-[${ui().text}]`}
              searchStyle={{ ...ui().inset, borderRadius: 8, height: size.control, paddingHorizontal: 8, marginBottom: 4 }}
              empty={<Text style={{ paddingVertical: 20, textAlign: "center", fontSize: 13, color: ui().muted }}>No region matches</Text>}
              offset={4}
              margin={8}
              // Wider than the trigger on the desktops: the titles and their codes side by side.
              popupStyle={desktop ? { ...surface(), width: 340 } : surface()}
              backdropStyle={backdrop}
              itemClass="active:opacity-70"
              // As wide as the trigger, so the clear button lands over its end.
              style={desktop ? { width: 260 } : undefined}
              cleanable
              clearButtonAccessibilityLabel="Clear the region"
              clearButtonClass="absolute items-center justify-center rounded-full enabled:hover:opacity-70"
              clearButtonStyle={{ top: (size.control - 20) / 2, right: 10, width: 20, height: 20 }}
              clearButton={<Text style={{ fontSize: 12, color: ui().muted }}>✕</Text>}
              trigger={<Trigger title={titleOf(REGIONS, region())} placeholder="Choose a region" open={regionOpen()} disabled={locked()} clearable={region() !== null} />}
              renderItem={(item) => <Row item={item} detail={item.disabled ? "At capacity" : item.value} />}
              renderGroup={(group) => <Header group={group} />}
            />
          </Field>
        </View>
      </Split>
    </View>
  );
}

mount(App);
