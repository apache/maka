import { signal, Text, View } from "nsh";
import { toast } from "../toast";
import { play, SOUNDS } from "../../nsh-gallery-ui/sound";
import { LucideIcon } from "../icons";
import { alpha, Button, Caption, Card, colors, DemoPage, focusRing, hovered, mono, radius, Toggle } from "../ui";

/**
 * `Sound` of `nsh`: the gallery's sounds (cuelume's cues, MIT), one for each
 * kind of moment, and the controls that play them as they change.
 */
export function SoundDemo() {
  return <DemoPage cards={[Library, InUse]} />;
}

/** The sounds, a row each: pressing one plays it. A row's fill is its own,
 * rounded and a little wider than its text, the same under the pointer and
 * pressed (a shade deeper), so a press never reads as a box. */
function Library() {
  return (
    <Card title="Sounds" subtitle="One for each kind of moment">
      <View style={{ gap: 2 }}>
        {SOUNDS.map((sound) => (
          <View
            role="button"
            onPress={() => play(sound.name)}
            accessibilityLabel={`Play ${sound.name}`}
            focusable
            focusStyle={focusRing()}
            hoverStyle={hovered()}
            activeStyle={{ backgroundColor: alpha(colors.text, 0.08) }}
            style={{ flexDirection: "row", alignItems: "center", gap: 12, marginHorizontal: -8, paddingHorizontal: 8, paddingVertical: 8, borderRadius: radius.inset }}
          >
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: 15, fontFamily: mono, color: colors.text }}>{sound.name}</Text>
              <Text style={{ fontSize: 13, color: colors.muted }}>{sound.purpose}</Text>
            </View>
            <LucideIcon name="play" size={16} tint={colors.faint} />
          </View>
        ))}
      </View>
    </Card>
  );
}

/** Controls that sound as they change: a switch, and toasts by their kind. */
function InUse() {
  const on = signal(true);
  return (
    <Card title="With the UI" subtitle="Quiet, short, and only where a change is worth hearing">
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Caption label="A switch sounds as it turns, a little lower off" />
        </View>
        <Toggle value={on()} onChange={(v) => on.set(v)} label="Sounds" />
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button label="Save" onPress={() => void toast({ title: "Saved", kind: "success" })} />
        <Button label="Remind" variant="secondary" onPress={() => void toast({ title: "Standup starts in 5 minutes", kind: "info" })} />
        <Button label="Pay" variant="danger" onPress={() => void toast({ title: "The card was declined", kind: "error" })} />
      </View>
    </Card>
  );
}
