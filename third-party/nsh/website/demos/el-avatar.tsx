import { type JSX, mount, reduceMotion, signal, Text, View } from "nsh";
import { Avatar, AvatarGroup, Button } from "nsh/base";
import { AVATAR_BROKEN, avatarIdentity, avatarPortrait, button, buttonText, desktop, focusRing, hoverFill, Log, Panel, Segmented, Split, ui } from "./palette";

// The look is the demo's: initials on a tint of the person's hue, the
// picture round over them (the parts are rounded, not the avatar, so a
// presence dot over it is not clipped), a ring of the card around stacked
// avatars, a dot whose color fades as it changes, a picture that fades in.

type Presence = "online" | "away" | "busy";
const PRESENCE: Presence[] = ["online", "away", "busy"];
const dotColor = (p: Presence) => (p === "online" ? ui().up : p === "away" ? ui().warn : ui().danger);
const surface = () => ui().card.backgroundColor;

function Person(props: {
  name: string;
  side: number;
  src?: string;
  label?: string;
  ring?: boolean;
  onStatus?: (status: string) => void;
  children?: JSX.Element;
}) {
  const id = () => avatarIdentity(props.name);
  return (
    <Avatar
      src={props.src}
      name={props.name}
      accessibilityLabel={props.label}
      fallbackDelay={300}
      onStatusChange={({ status }) => props.onStatus?.(status)}
      style={{
        width: props.side,
        height: props.side,
        ...(props.ring ? { borderRadius: props.side / 2, borderWidth: 2, borderColor: surface(), backgroundColor: surface() } : {}),
      }}
      imageClass={`rounded-full overflow-hidden ${reduceMotion() ? "" : "transition-opacity duration-300"}`}
      fallbackClass={`rounded-full overflow-hidden items-center justify-center font-semibold text-[${Math.round(props.side / 2.8)}px] text-[${id().foreground}]`}
      fallbackStyle={{ backgroundColor: id().background, borderWidth: 1, borderColor: id().border }}
    >
      {props.children}
    </Avatar>
  );
}

const TEAM = ["Ada Lovelace", "Grace Hopper", "Alan Turing"];
const MEMBERS = ["Ada Lovelace", "Grace Hopper", "Alan Turing", "Katherine Johnson", "Edsger Dijkstra", "Barbara Liskov", "Donald Knuth", "Frances Allen", "Radia Perlman", "Ken Thompson"];

function App() {
  const presence = signal<Presence[]>(["online", "busy", "away"]);
  const members = signal(8);
  const limit = signal(3);
  const events = signal<string[]>([]);
  const log = (line: string) => events.set([line, ...events()].slice(0, 5));
  const side = desktop ? 36 : 44;
  const more = () => Math.max(0, members() - limit());
  const label = { fontSize: desktop ? 13 : 15, color: ui().text } as const;
  const detail = { fontSize: 12, color: ui().muted } as const;
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>avatar</Text>
      <Text style={{ color: ui().muted }}>{desktop ? "Click a member to change their presence" : "Tap a member to change their presence"}</Text>

      <Split
        gap={14}
        inspector={
          <>
            <Panel title="AvatarGroup · limit">
              <Segmented options={[2, 3, 4]} value={limit()} onChange={(v) => (limit.set(v), log(`limit ${v}`))} />
              <View style={{ flexDirection: "row", gap: 8, marginTop: 6 }}>
                <Button onPress={() => (members.set(Math.min(MEMBERS.length, members() + 1)), log(`members ${members()}`))} disabled={members() >= MEMBERS.length} {...button("secondary")}>
                  <Text style={buttonText()}>Add</Text>
                </Button>
                <Button onPress={() => (members.set(Math.max(1, members() - 1)), log(`members ${members()}`))} disabled={members() <= 1} {...button("ghost")}>
                  <Text style={buttonText("ghost")}>Remove</Text>
                </Button>
              </View>
            </Panel>
            <Log title="onStatusChange" lines={events()} minHeight={110} />
          </>
        }
      >
        <View style={{ ...ui().card, borderRadius: 16, padding: desktop ? 12 : 16, gap: 14 }}>
          <View>
            {TEAM.map((name, i) => (
              <Button
                onPress={() => {
                  const next = PRESENCE[(PRESENCE.indexOf(presence()[i]) + 1) % PRESENCE.length];
                  presence.set(presence().map((p, j) => (j === i ? next : p)));
                  log(`${name}: ${next}`);
                }}
                class="-mx-2 flex-row items-center gap-3 rounded-lg px-2 py-2 active:opacity-70"
                hoverStyle={hoverFill()}
                focusStyle={focusRing()}
              >
                <Person name={name} side={side} src={i === 2 ? undefined : avatarPortrait(name)} label={`${name}, ${presence()[i]}`} onStatus={(s) => log(`${name}: ${s}`)}>
                  <View
                    class={reduceMotion() ? "" : "transition-colors duration-200"}
                    style={{ position: "absolute", right: -1, bottom: -1, width: 11, height: 11, borderRadius: 6, borderWidth: 2, borderColor: surface(), backgroundColor: dotColor(presence()[i]) }}
                  />
                </Person>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ ...label, fontWeight: "500" }}>{name}</Text>
                  <Text style={detail}>{presence()[i]}</Text>
                </View>
              </Button>
            ))}
          </View>
          <View style={{ height: 1, backgroundColor: ui().line }} />
          <View class="flex-row items-center gap-3">
            <AvatarGroup
              limit={limit()}
              accessibilityLabel={`${members()} members`}
              class="flex-row items-center"
              overflowClass="items-center justify-center rounded-full"
              overflowStyle={{ ...ui().raised, width: side, height: side, marginLeft: -side / 4, borderWidth: 2, borderColor: surface() }}
              overflowAccessibilityLabel={`${more()} more people`}
              overflow={<Text style={{ fontSize: side / 3.2, fontWeight: "600", color: ui().muted, fontVariant: ["tabular-nums"] }}>{`+${more()}`}</Text>}
            >
              <Each of={MEMBERS.slice(0, members())}>
                {(name, i) => (
                  <View style={{ marginLeft: i() === 0 ? 0 : -side / 4 }}>
                    <Person name={name()} side={side} ring src={i() % 3 === 2 ? undefined : avatarPortrait(name())} />
                  </View>
                )}
              </Each>
            </AvatarGroup>
            <Text style={detail}>{`${members()} members`}</Text>
          </View>
          <View style={{ height: 1, backgroundColor: ui().line }} />
          <View class="flex-row items-start gap-3">
            <Person name="Barbara Liskov" side={desktop ? 28 : 32} src={AVATAR_BROKEN} label="" onStatus={(s) => log(`Barbara Liskov: ${s}`)} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={detail}>
                <Text style={{ fontWeight: "600", color: ui().text }}>Barbara Liskov</Text>
                {"  40m · her picture failed to load"}
              </Text>
              <Text style={label}>Same as before within a millisecond.</Text>
            </View>
          </View>
        </View>
      </Split>
    </View>
  );
}

mount(App);
