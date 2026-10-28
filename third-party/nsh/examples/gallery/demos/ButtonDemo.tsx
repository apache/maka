import { cleanup, signal, Text, View } from "nsh";
import { platform } from "nsh";
import { Button, Caption, Card, colors, DemoPage, mono, RoundButton, Toggle } from "../ui";

// `nsh/base`'s `Button` owns presses, the disabled state, keyboard focus and
// the button role; the look is the gallery's (`Button` of `nsh-gallery-ui`):
// a raised neutral, the citrus main action, a quiet ghost, a color of the
// app's, each with its hover, pressed, focus and disabled states.

const pointer = platform.idiom === "desktop";

/**
 * Button: the kinds a decision area uses, with an icon or only one, and
 * the states the app owns (disabled, busy).
 */
export function ButtonDemo() {
  const last = signal("—");

  function Kinds() {
    return (
      <Card title="Kinds" subtitle="One main action; the others quieter">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Button label="Save" onPress={() => last.set("pressed Save")} />
          <Button label="Duplicate" variant="secondary" onPress={() => last.set("pressed Duplicate")} />
          <Button label="Cancel" variant="ghost" onPress={() => last.set("pressed Cancel")} />
          <Button label="Delete" variant="danger" onPress={() => last.set("pressed Delete")} />
        </View>
        <Caption label={pointer ? "Hover, press and Tab to each: one focus ring for every control" : "Press each: it sinks under the finger"} />
      </Card>
    );
  }

  function Icons() {
    return (
      <Card title="With an icon" subtitle="Before the label, or alone with a label for screen readers">
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <Button label="New file" icon="plus" variant="secondary" onPress={() => last.set("pressed New file")} />
          <Button label="Search" icon="search" variant="ghost" onPress={() => last.set("pressed Search")} />
          <RoundButton icon="play" label="Play" onPress={() => last.set("pressed Play")} />
          <RoundButton icon="star" label="Favorite" variant="secondary" onPress={() => last.set("pressed Favorite")} />
        </View>
      </Card>
    );
  }

  function States() {
    const disabled = signal(false);
    const busy = signal(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    cleanup(() => clearTimeout(timer));
    const send = () => {
      busy.set(true);
      last.set("Send: started");
      timer = setTimeout(() => {
        busy.set(false);
        last.set("Send: done");
      }, 1500);
    };
    return (
      <Card title="States" subtitle="Disabled and busy: the app owns both" right={<Toggle value={disabled()} onChange={(v) => disabled.set(v)} label="Disabled" />}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Button label={busy() ? "Sending…" : "Send"} disabled={disabled() || busy()} onPress={send} />
          <Button label="Archive" variant="secondary" disabled={disabled()} onPress={() => last.set("pressed Archive")} />
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

  return <DemoPage cards={[Kinds, Icons, States, Last]} />;
}
