import { type JSX, platform, reduceMotion, signal, Text, View } from "nsh";
import { Avatar, AvatarGroup, Button } from "nsh/base";
import {
  alpha,
  AVATAR_BROKEN,
  avatarIdentity,
  avatarPortrait,
  Badge,
  Caption,
  Card,
  colors,
  DemoPage,
  focusRing,
  hovered,
  Segmented,
  Button as UiButton,
} from "../ui";

// `nsh/base`'s `Avatar` owns the image's loading state (the fallback while
// it loads, after `fallbackDelay`, and when it fails; the image once it has
// loaded) and what screen readers hear (an image named after the person);
// `AvatarGroup` shows the first `limit` avatars and its overflow while more
// people are in it. The look is the gallery's: initials on a tint of the
// person's hue, a ring of the card's surface around stacked avatars, a
// presence dot over the picture whose color fades as it changes, an image
// that fades in; none of the motion with reduced motion.

const pointer = platform.idiom === "desktop";

type Presence = "online" | "away" | "busy" | "offline";
const PRESENCE: Presence[] = ["online", "away", "busy", "offline"];
const presenceColor = (p: Presence) =>
  p === "online" ? colors.up : p === "away" ? colors.warn : p === "busy" ? colors.danger : colors.faint;

const fade = (ms: number) => (reduceMotion() ? "" : `transition-opacity duration-${ms} ease-out`);

/**
 * An avatar in the gallery's look: `side` points round, the initials on a
 * tint of the person's hue (their size a third of the side), the picture
 * round over them. `ring` draws a ring of the card's surface around it, as
 * stacked avatars and a profile's picture have. Its children (a presence
 * dot, a badge) sit over the picture, unclipped.
 */
function Person(props: {
  name?: string;
  side: number;
  src?: string;
  label?: string;
  ring?: boolean;
  delay?: number;
  fadeIn?: boolean;
  fallback?: JSX.Element;
  onStatus?: (status: string) => void;
  children?: JSX.Element;
}) {
  const id = () => avatarIdentity(props.name ?? "");
  const round = () => `rounded-full overflow-hidden`;
  return (
    <Avatar
      src={props.src}
      name={props.name}
      accessibilityLabel={props.label}
      fallbackDelay={props.delay}
      onStatusChange={({ status }) => props.onStatus?.(status)}
      style={{
        width: props.side,
        height: props.side,
        flexShrink: 0,
        ...(props.ring ? { borderRadius: props.side / 2, borderWidth: 2, borderColor: colors.surface, backgroundColor: colors.surface } : {}),
      }}
      imageClass={`${round()} ${props.fadeIn ? fade(300) : ""}`}
      fallbackClass={`${round()} items-center justify-center font-semibold text-[${Math.round(props.side / 2.8)}px] text-[${id().foreground}]`}
      fallbackStyle={{ backgroundColor: id().background, borderWidth: 1, borderColor: id().border }}
      fallback={props.fallback}
    >
      {props.children}
    </Avatar>
  );
}

/** A presence dot at the avatar's bottom-right, ringed by the card's surface. */
function Dot(props: { presence: Presence; side: number }) {
  const d = () => Math.max(8, Math.round(props.side / 4));
  return (
    <View
      class={reduceMotion() ? "" : "transition-colors duration-200"}
      style={{
        position: "absolute",
        right: -1,
        bottom: -1,
        width: d(),
        height: d(),
        borderRadius: d() / 2,
        borderWidth: 2,
        borderColor: colors.surface,
        backgroundColor: props.presence === "offline" ? colors.surface : presenceColor(props.presence),
        ...(props.presence === "offline" ? { borderWidth: 2, borderColor: colors.faint } : {}),
      }}
    />
  );
}

/** Lucide's user glyph, for someone without a name. */
function UserGlyph(props: { size: number; tint: string }) {
  const s = () => props.size;
  return (
    <View style={{ width: s(), height: s(), alignItems: "center" }}>
      <View style={{ width: s() * 0.42, height: s() * 0.42, borderRadius: s(), borderWidth: 1.75, borderColor: props.tint, marginTop: s() * 0.06 }} />
      <View
        style={{
          width: s() * 0.72,
          height: s() * 0.34,
          marginTop: s() * 0.08,
          borderTopLeftRadius: s(),
          borderTopRightRadius: s(),
          borderWidth: 1.75,
          borderBottomWidth: 0,
          borderColor: props.tint,
        }}
      />
    </View>
  );
}

const TEAM: { name: string; role: string; presence: Presence; picture: boolean }[] = [
  { name: "Ada Lovelace", role: "Engineering lead", presence: "online", picture: true },
  { name: "Grace Hopper", role: "Compilers", presence: "busy", picture: true },
  { name: "Alan Turing", role: "Research", presence: "away", picture: false },
  { name: "Katherine Johnson", role: "Trajectories", presence: "online", picture: true },
  { name: "Edsger Dijkstra", role: "Reviews", presence: "offline", picture: false },
];

const MEMBERS = [
  "Ada Lovelace",
  "Grace Hopper",
  "Alan Turing",
  "Katherine Johnson",
  "Edsger Dijkstra",
  "Barbara Liskov",
  "Donald Knuth",
  "Frances Allen",
  "Margaret Hamilton",
  "Claude Shannon",
  "Radia Perlman",
  "Ken Thompson",
];

/**
 * Avatar and AvatarGroup: a team with presence dots, a stacked group with
 * its overflow, a comment thread, a profile header whose picture changes,
 * pictures that load, fail and are missing, and an image that fades in
 * without the fallback flashing first.
 */
export function AvatarDemo() {
  const last = signal("—");
  const row = pointer ? 32 : 40;
  const body = pointer ? 13 : 15;
  const note = pointer ? 12 : 13;

  function Team() {
    const presence = signal<Presence[]>(TEAM.map((m) => m.presence));
    const online = () => presence().filter((p) => p === "online").length;
    return (
      <Card title="Team" subtitle="Presence dots over the pictures; press a member to change theirs" right={<Badge label={`${online()} online`} tone="up" />}>
        <View>
          <Each of={TEAM}>
            {(m, i) => {
              const p = () => presence()[i()];
              return (
                <Button
                  onPress={() => {
                    const next = PRESENCE[(PRESENCE.indexOf(p()) + 1) % PRESENCE.length];
                    presence.set(presence().map((v, j) => (j === i() ? next : v)));
                    last.set(`${m().name}: ${next}`);
                  }}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 12,
                    minHeight: pointer ? 44 : 60,
                    paddingHorizontal: 8,
                    marginHorizontal: -8,
                    borderRadius: 8,
                    borderTopWidth: i() === 0 ? 0 : 1,
                    borderTopColor: colors.line,
                  }}
                  hoverStyle={hovered()}
                  activeStyle={{ backgroundColor: alpha(colors.text, 0.08) }}
                  focusStyle={focusRing()}
                >
                  <Person name={m().name} side={row} src={m().picture ? avatarPortrait(m().name) : undefined} label={`${m().name}, ${p()}`}>
                    <Dot presence={p()} side={row} />
                  </Person>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ fontSize: body, fontWeight: "500", color: colors.text }}>{m().name}</Text>
                    <Text style={{ fontSize: note, color: colors.muted }}>{m().role}</Text>
                  </View>
                  <Text style={{ fontSize: note, color: presenceColor(p()) }}>{p()}</Text>
                </Button>
              );
            }}
          </Each>
        </View>
      </Card>
    );
  }

  function Stacked() {
    const count = signal(9);
    const limit = signal<"3" | "4" | "5">("4");
    const shown = () => Number(limit());
    const side = pointer ? 32 : 40;
    const people = () => MEMBERS.slice(0, count());
    const more = () => Math.max(0, count() - shown());
    return (
      <Card title="Stacked group" subtitle="The first few overlap; the overflow stands for the rest" right={<Badge label={`${count()} members`} />}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <AvatarGroup
            limit={shown()}
            accessibilityLabel={`${count()} members`}
            class="flex-row items-center"
            overflowClass={`items-center justify-center rounded-full ${reduceMotion() ? "" : "transition-colors duration-200"}`}
            overflowStyle={{ width: side, height: side, marginLeft: -side / 4, borderWidth: 2, borderColor: colors.surface, backgroundColor: colors.raised }}
            overflowAccessibilityLabel={`${more()} more people`}
            overflow={<Text style={{ fontSize: side / 3.2, fontWeight: "600", color: colors.muted, fontVariant: ["tabular-nums"] }}>{`+${more()}`}</Text>}
          >
            <Each of={people()}>
              {(name, i) => (
                <View style={{ marginLeft: i() === 0 ? 0 : -side / 4 }}>
                  <Person name={name()} side={side} ring src={i() % 3 === 2 ? undefined : avatarPortrait(name())} />
                </View>
              )}
            </Each>
          </AvatarGroup>
          <Text style={{ flex: 1, fontSize: note, color: colors.muted }}>{more() > 0 ? `and ${more()} more` : "everyone shown"}</Text>
        </View>
        <Segmented
          options={[
            { value: "3", label: "3 shown" },
            { value: "4", label: "4 shown" },
            { value: "5", label: "5 shown" },
          ]}
          value={limit()}
          onChange={(v) => {
            limit.set(v);
            last.set(`Limit: ${v}`);
          }}
          size="small"
        />
        <View style={{ flexDirection: "row", gap: 8 }}>
          <UiButton label="Add member" icon="plus" size="small" disabled={count() >= MEMBERS.length} onPress={() => (count.set(count() + 1), last.set(`Members: ${count()}`))} />
          <UiButton label="Remove" icon="minus" size="small" variant="ghost" disabled={count() <= 1} onPress={() => (count.set(count() - 1), last.set(`Members: ${count()}`))} />
        </View>
        <Caption label="Viewers of a long list: only the three shown are made" note="1,284 viewers" />
        <AvatarGroup
          limit={3}
          total={1284}
          accessibilityLabel="1,284 viewers"
          class="flex-row items-center"
          overflowClass="items-center justify-center rounded-full px-2"
          overflowStyle={{ height: 28, marginLeft: -6, borderWidth: 2, borderColor: colors.surface, backgroundColor: colors.raised }}
          overflowAccessibilityLabel="1,281 more viewers"
          overflow={<Text style={{ fontSize: 11, fontWeight: "600", color: colors.muted, fontVariant: ["tabular-nums"] }}>+1.3k</Text>}
        >
          <Each of={MEMBERS.slice(6, 9)}>
            {(name, i) => (
              <View style={{ marginLeft: i() === 0 ? 0 : -6 }}>
                <Person name={name()} side={28} ring src={avatarPortrait(name())} label="" />
              </View>
            )}
          </Each>
        </AvatarGroup>
      </Card>
    );
  }

  function Thread() {
    const comments = [
      { name: "Grace Hopper", time: "2h", text: "The compiler change is in. Benchmarks look steady.", src: avatarPortrait("Grace Hopper"), reply: false },
      { name: "Alan Turing", time: "1h", text: "Did the cold start move? The last run was noisy.", src: AVATAR_BROKEN, reply: true },
      { name: "Barbara Liskov", time: "40m", text: "Same as before within a millisecond.", src: undefined, reply: true },
    ];
    return (
      <Card title="Comment thread" subtitle="Pictures beside the names, decorative for screen readers">
        <View style={{ gap: 14 }}>
          <Each of={comments}>
            {(c) => (
              <View style={{ flexDirection: "row", gap: 10, paddingLeft: c().reply ? (pointer ? 28 : 34) : 0 }}>
                <Person name={c().name} side={pointer ? 24 : 30} src={c().src} label="" />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ fontSize: note, color: colors.muted }}>
                    <Text style={{ fontWeight: "600", color: colors.text }}>{c().name}</Text>
                    {`  ${c().time}`}
                  </Text>
                  <Text style={{ fontSize: body, lineHeight: body * 1.45, color: colors.text }}>{c().text}</Text>
                </View>
              </View>
            )}
          </Each>
        </View>
      </Card>
    );
  }

  function Profile() {
    const pictures = ["Margaret Hamilton", "Radia Perlman", "Frances Allen"];
    const picture = signal<number | null>(0);
    const status = signal("—");
    const side = pointer ? 64 : 76;
    return (
      <Card title="Profile header" subtitle="A large picture that fades in when it changes, initials without one" right={<Badge label={status()} tone={status() === "loaded" ? "up" : "neutral"} />}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
          <Person
            name="Margaret Hamilton"
            side={side}
            ring
            fadeIn
            src={picture() === null ? undefined : avatarPortrait(pictures[picture()!])}
            onStatus={(s) => {
              status.set(s);
              last.set(`Profile picture: ${s}`);
            }}
          >
            <View
              style={{
                position: "absolute",
                right: 0,
                bottom: 0,
                paddingHorizontal: 6,
                height: 20,
                borderRadius: 10,
                justifyContent: "center",
                borderWidth: 2,
                borderColor: colors.surface,
                backgroundColor: colors.accent,
              }}
            >
              <Text style={{ fontSize: 10, fontWeight: "700", color: colors.onAccent }}>PRO</Text>
            </View>
          </Person>
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={{ fontSize: pointer ? 17 : 19, fontWeight: "600", color: colors.text }}>Margaret Hamilton</Text>
            <Text style={{ fontSize: note, color: colors.muted }}>@margaret · Flight software</Text>
            <Text style={{ fontSize: note, color: colors.faint, fontVariant: ["tabular-nums"] }}>128 following · 4.2k followers</Text>
          </View>
        </View>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <UiButton
            label="Change picture"
            icon="photos"
            size="small"
            onPress={() => {
              picture.set(((picture() ?? -1) + 1) % pictures.length);
              last.set("Profile picture: changed");
            }}
          />
          <UiButton
            label="Remove picture"
            icon="trash"
            size="small"
            variant="ghost"
            disabled={picture() === null}
            onPress={() => {
              picture.set(null);
              last.set("Profile picture: removed");
            }}
          />
        </View>
      </Card>
    );
  }

  function States() {
    // A new key makes the avatars again, so their loads run once more.
    const round = signal(0);
    const statuses = signal<Record<string, string>>({});
    const cases = [
      { key: "loads", title: "Loads", name: "Katherine Johnson", src: avatarPortrait("Katherine Johnson") },
      { key: "fails", title: "Fails", name: "Alan Turing", src: AVATAR_BROKEN },
      { key: "none", title: "No picture", name: "Donald Knuth", src: undefined },
      { key: "anon", title: "No name", name: undefined, src: undefined },
    ];
    const side = pointer ? 44 : 52;
    return (
      <Card title="Loading and failing" subtitle="The fallback while a picture loads, when it fails, and without one" right={<Badge label={`round ${round() + 1}`} />}>
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Each of={cases}>
            {(c) => (
              <View style={{ alignItems: "center", gap: 6, flex: 1 }}>
                <Each of={[round()]}>
                  {() => (
                  <Person
                    name={c().name}
                    side={side}
                    src={c().src}
                    label={c().name ?? "Guest"}
                    fallback={c().name ? undefined : <UserGlyph size={side * 0.5} tint={colors.muted} />}
                    onStatus={(s) => statuses.set({ ...statuses(), [c().key]: s })}
                  />
                  )}
                </Each>
                <Text style={{ fontSize: note, fontWeight: "500", color: colors.text }}>{c().title}</Text>
                <Text style={{ fontSize: note - 1, color: colors.faint }}>{statuses()[c().key] ?? "idle"}</Text>
              </View>
            )}
          </Each>
        </View>
        <UiButton
          label="Load again"
          icon="play"
          size="small"
          onPress={() => {
            statuses.set({});
            round.set(round() + 1);
            last.set(`Load again: round ${round() + 1}`);
          }}
        />
      </Card>
    );
  }

  function Delay() {
    const round = signal(0);
    const log = signal<string[]>([]);
    let start = Date.now();
    const report = (who: string) => (s: string) => log.set([`${who}: ${s} at ${Date.now() - start} ms`, ...log()].slice(0, 4));
    const side = pointer ? 44 : 52;
    return (
      <Card title="Without a flash" subtitle="The fallback waits 400 ms while the picture loads, and the picture fades in">
        <View style={{ flexDirection: "row", gap: 24 }}>
          <Each of={[round()]}>
            {() => (
            <>
            <View style={{ alignItems: "center", gap: 6 }}>
              <Person name="Claude Shannon" side={side} src={avatarPortrait("Claude Shannon")} onStatus={report("no delay")} />
              <Text style={{ fontSize: note, color: colors.muted }}>No delay</Text>
            </View>
            <View style={{ alignItems: "center", gap: 6 }}>
              <Person name="Claude Shannon" side={side} src={avatarPortrait("Claude Shannon")} delay={400} fadeIn onStatus={report("400 ms")} />
              <Text style={{ fontSize: note, color: colors.muted }}>400 ms, fades in</Text>
            </View>
            </>
            )}
          </Each>
        </View>
        <View style={{ gap: 2, minHeight: 4 * (note + 6) }}>
          <Each of={log()}>{(line) => <Text style={{ fontSize: note, color: colors.faint, fontVariant: ["tabular-nums"] }}>{line()}</Text>}</Each>
        </View>
        <UiButton
          label="Replay"
          icon="play"
          size="small"
          onPress={() => {
            start = Date.now();
            log.set([]);
            round.set(round() + 1);
            last.set("Replay");
          }}
        />
      </Card>
    );
  }

  function Last() {
    return (
      <Card title="Last change">
        <Caption label={last()} note={pointer ? "Tab to a member, Space changes their presence" : "Tap a member"} />
      </Card>
    );
  }

  return <DemoPage cards={[Team, Stacked, Thread, Profile, States, Delay, Last]} />;
}
