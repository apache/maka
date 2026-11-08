import { type JSX, mount, signal, Text, View } from "nsh";
import { Button, type OpenChangeReason, Select, Switch } from "nsh/base";
import { button, buttonText, desktop, Log, Panel, size, Split, switchLook, ui, RowLabel, sectionSurface, listRow, clearButtonLook, ListboxEmpty, ListboxHeader, listboxProps, listboxSearch, OptionRow, Picker } from "./palette";

// Two selects in a settings card: a plain one (typeahead jumps by letter)
// and a searchable one with sections, a disabled item and an empty state.
// The look is the shared listbox look: the trigger (`Picker`) on the raised
// finish with the chosen title and a chevron that turns while the list is
// open, its edge lit then; the list (`listboxProps`) a popup at the trigger
// with a pointer, a sheet on a touch screen; the highlighted row (the keys
// or the pointer) in the brand tint, the chosen one bolder with a check.

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

/** A trigger's width: set with a pointer, the field's on a touch screen. */
const trigger = desktop ? { width: 260 } : undefined;

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
                {...button("secondary", { size: "sm", disabled: () => region() === null, style: { marginTop: 6 } })}
              >
                <Text style={buttonText("secondary", { size: "sm" })}>Clear region</Text>
              </Button>
              <Switch
                checked={locked()}
                onChange={({ checked }) => locked.set(checked)}
                {...listRow({ first: true, style: { flexDirection: "row-reverse", marginTop: 4 } })}
                {...switchLook(() => locked())}
              >
                <RowLabel label="Region disabled" />
              </Switch>
            </Panel>
            <Log title="onChange · onOpenChange" lines={events()} minHeight={120} />
          </>
        }
      >
        <View style={{ ...sectionSurface({ padded: true }), gap: 20 }}>
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
              {...listboxProps()}
              trigger={<Picker title={titleOf(LANGUAGES, language()) ?? "Choose a language"} placeholder={language() === null} open={languageOpen()} style={trigger} />}
              renderItem={(item) => <OptionRow item={item} />}
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
              searchAccessibilityLabel="Search regions"
              {...listboxSearch()}
              empty={<ListboxEmpty label="No region matches" />}
              // Wider than the trigger on the desktops: the titles and their codes side by side.
              {...listboxProps({ minWidth: 340 })}
              // As wide as the trigger, so the clear button lands over its end.
              style={trigger}
              cleanable
              clearButtonAccessibilityLabel="Clear the region"
              {...clearButtonLook({ over: true })}
              trigger={
                <Picker title={titleOf(REGIONS, region()) ?? "Choose a region"} placeholder={region() === null} open={regionOpen()} disabled={locked()} clearable={region() !== null} style={trigger} />
              }
              renderItem={(item) => <OptionRow item={item} note={item.disabled ? "At capacity" : item.value} />}
              renderGroup={(group) => <ListboxHeader group={group} />}
            />
          </Field>
        </View>
      </Split>
    </View>
  );
}

mount(App);
