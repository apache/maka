import { mount, signal, Text, View } from "nsh";
import { Button, Switch } from "nsh/base";
import { button, buttonText, desktop, Inspector, Panel, size, Stage, tint, ui, wide } from "./palette";

const track = `${desktop ? "w-9" : "w-12"} rounded-full p-0.5 transition-colors motion-reduce:transition-none`;
const thumb = desktop ? "size-4 rounded-full transition-transform motion-reduce:transition-none checked:translate-x-4" : "size-5.5 rounded-full transition-transform motion-reduce:transition-none checked:translate-x-5";

function App() {
  const presses = signal(0);
  const pressing = signal(false);
  const disabled = signal(false);
  const bold = signal(true);
  const italic = signal(false);
  const last = signal("–");
  const label = () => ({ color: ui().text, fontSize: desktop ? 13 : 15, fontWeight: "600" as const });

  const counter = () => (
    <Button
      onPress={() => {
        presses.update((n) => n + 1);
        last.set(`counter ${presses()}`);
      }}
      onPressDown={() => pressing.set(true)}
      onPressUp={() => pressing.set(false)}
      disabled={disabled()}
      {...button("accent")}
    >
      <Text style={buttonText("accent")}>Pressed {presses()}×</Text>
    </Button>
  );
  const pressState = () => `${pressing() ? "onPressDown: pressing…" : "onPressUp: released"} · disabled ${String(disabled())}`;
  const disabler = () => (
    <Switch
      checked={disabled()}
      onChange={(next) => disabled.set(next)}
      class={`flex-row items-center gap-2 active:opacity-70 ${desktop && !wide() ? "self-start" : ""}`}
      trackClass={track}
      trackStyle={disabled() ? ui().accentFill : ui().inset}
      thumbClass={thumb}
      thumbStyle={disabled() ? { backgroundColor: ui().onAccent } : ui().raised}
    >
      <Text style={label()}>{wide() ? (disabled() ? "Enable it" : "Disable it") : disabled() ? "Enable the button above" : "Disable the button above"}</Text>
    </Switch>
  );
  const toggle = (name: string, on: () => boolean, flip: () => void, text: () => object, glyph: string) => (
    <Button
      selected={on()}
      onPress={flip}
      accessibilityLabel={name}
      {...button("secondary", { align: "flex-start", style: { width: size.control, paddingHorizontal: 0 } })}
      selectedStyle={{ backgroundColor: tint(ui().accent, 0.25), backgroundImage: "none", borderColor: ui().accent }}
    >
      <Text style={text()}>{glyph}</Text>
    </Button>
  );
  const toggles = () => (
    <>
      {toggle("Bold", bold, () => bold.set(!bold()), () => ({ ...label(), fontWeight: "800" }), "B")}
      {toggle("Italic", italic, () => italic.set(!italic()), () => ({ ...label(), fontStyle: "italic" }), "I")}
    </>
  );
  const caption = (text: string) => <Text style={{ fontSize: 12, color: ui().muted }}>{text}</Text>;

  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 12 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>button</Text>
      <Text style={{ color: ui().muted }}>{desktop ? "Click, hover, or Tab to a button and press Space" : "Tap; move your finger away to cancel"}</Text>

      {() =>
        wide() ? (
          <View style={{ flex: 1, flexDirection: "row", gap: 16 }}>
            <Stage width={360} gap={24}>
              <View style={{ gap: 8 }}>
                {caption("onPress, onPressDown, onPressUp")}
                <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                  {counter()}
                  {disabler()}
                </View>
              </View>
              <View style={{ gap: 8 }}>
                {caption("selected: toggles")}
                <View style={{ flexDirection: "row", gap: 8 }}>{toggles()}</View>
              </View>
            </Stage>
            <Inspector>
              <Panel title="press · disabled">
                <Text style={{ fontSize: 13, color: ui().text }}>{pressState()}</Text>
              </Panel>
              <Panel title="selected">
                <Text style={{ fontSize: 13, color: ui().text }}>
                  bold {String(bold())} · italic {String(italic())}
                </Text>
              </Panel>
              <Panel title="last onPress">
                <Text style={{ fontSize: 13, color: ui().up }}>{last()}</Text>
              </Panel>
            </Inspector>
          </View>
        ) : (
          <View style={{ gap: 12 }}>
            {counter()}
            <Text style={{ color: ui().muted, fontSize: 13 }}>{pressState()}</Text>

            {disabler()}

            <Text style={{ color: ui().muted, marginTop: 6 }}>selected: toggles</Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              {toggles()}
              <Text style={{ color: ui().muted, alignSelf: "center", flex: 1 }}>
                bold {String(bold())} · italic {String(italic())}
              </Text>
            </View>

            <Text style={{ color: ui().up }}>last onPress: {last()}</Text>
          </View>
        )
      }
    </View>
  );
}

mount(App);
