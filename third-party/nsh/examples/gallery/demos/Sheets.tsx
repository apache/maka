import { type JSX, keyboardFrame, safeArea, signal, Text, token, View, type ViewStyle, windowSize } from "nsh";
import { type OpenChangeReason, Sheet } from "nsh/base";
import { LucideIcon, type LucideIconName } from "../icons";
import { toast } from "../toast";
import { alpha, Appear, Badge, Button, Caption, Card, colors, DemoPage, desktop, hovered, Segmented, Toggle } from "../ui";
import { Avatar, createEvents, Field, pointer, Rule, Trigger } from "./OverlayUi";

type Side = "left" | "right" | "bottom";

/** A sheet's panel at `side`: the full height of an edge on a wide
 * window, the bottom of the screen with a grabber on a narrow one. */
function panel(side: Side): ViewStyle {
  const r = 16;
  if (side === "bottom") {
    return {
      backgroundColor: colors.surface,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      borderWidth: 1,
      borderBottomWidth: 0,
      borderColor: colors.border,
      maxHeight: windowSize().height - safeArea().top - 24,
      paddingHorizontal: 16,
      paddingTop: 8,
      // Above the keyboard while a field has it, above the home indicator otherwise.
      paddingBottom: Math.max(safeArea().bottom, keyboardFrame().height) + 16,
      gap: 14,
    };
  }
  return {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    width: Math.min(360, windowSize().width - 48),
    paddingHorizontal: 20,
    paddingTop: safeArea().top + 16,
    paddingBottom: safeArea().bottom + 16,
    gap: 16,
    ...(side === "right"
      ? { borderLeftWidth: 1, borderTopLeftRadius: r, borderBottomLeftRadius: r }
      : { borderRightWidth: 1, borderTopRightRadius: r, borderBottomRightRadius: r }),
  };
}

const backdrop = { backgroundColor: "rgba(0,0,0,0.45)" };

/** The top of a sheet: a grabber at the bottom of the screen, the title and a close button. */
function Head(props: { side: Side; title: string; right?: JSX.Element; onClose: () => void }) {
  return (
    <View style={{ gap: 8 }}>
      <If when={props.side === "bottom"}>
        <View style={{ width: 36, height: 5, borderRadius: 3, alignSelf: "center", backgroundColor: colors.raised }} />
      </If>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ flex: 1, fontSize: pointer ? 16 : 18, fontWeight: "600", color: colors.text }}>{props.title}</Text>
        {props.right}
        <Trigger icon="x" variant="ghost" accessibilityLabel="Close" onPress={props.onClose} />
      </View>
    </View>
  );
}

/** A titled group of a sheet's controls. */
function Group(props: { title: string; children: JSX.Element }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontSize: pointer ? 12 : 13, fontWeight: "600", color: colors.faint }}>{props.title}</Text>
      {props.children}
    </View>
  );
}

type Price = "any" | "under50" | "mid" | "over200";
type Filters = { sort: "relevance" | "newest" | "price"; price: Price; stock: boolean; shipping: boolean; sale: boolean };

const prices: { value: Price; label: string; share: number }[] = [
  { value: "any", label: "Any", share: 1 },
  { value: "under50", label: "Under $50", share: 0.35 },
  { value: "mid", label: "$50–200", share: 0.45 },
  { value: "over200", label: "Over $200", share: 0.2 },
];

const none: Filters = { sort: "relevance", price: "any", stock: false, shipping: false, sale: false };

/** How many of the 128 products pass `f`. */
const results = (f: Filters) =>
  Math.max(1, Math.round(128 * prices.find((p) => p.value === f.price)!.share * (f.stock ? 0.8 : 1) * (f.shipping ? 0.6 : 1) * (f.sale ? 0.25 : 1)));

/** The filters `f` sets, as labels. */
const active = (f: Filters) =>
  [f.price !== "any" ? prices.find((p) => p.value === f.price)!.label : null, f.stock ? "In stock" : null, f.shipping ? "Free shipping" : null, f.sale ? "On sale" : null].filter(
    (x): x is string => x !== null,
  );

type Mailbox = { id: string; icon: LucideIconName; label: string; count?: number };

const mailboxes: Mailbox[] = [
  { id: "inbox", icon: "inbox", label: "Inbox", count: 12 },
  { id: "starred", icon: "star", label: "Starred" },
  { id: "sent", icon: "send", label: "Sent" },
  { id: "drafts", icon: "file-text", label: "Drafts", count: 2 },
  { id: "archive", icon: "archive", label: "Archive" },
];

/**
 * Sheets of `nsh/base` as an app has them: filters edited as a draft and
 * applied by the footer's button; a form that saves; a navigation drawer
 * from the leading edge. On a wide window they are edge panels, on a narrow
 * one panels at the bottom that a swipe down closes; each slides in over a
 * fading backdrop, and the backdrop, Escape and back close it.
 */
export function Sheets() {
  const { log, Events } = createEvents("Open a sheet");
  // The shell remounts on a change of layout: read it once.
  const wide = desktop();
  const changed = (name: string, set: (open: boolean) => void) => ({ open, reason }: { open: boolean; reason: OpenChangeReason }) => {
    set(open);
    log(`${name} ${open ? "opened" : "closed"} (${reason})`);
  };

  function FilterSheet() {
    const side: Side = wide ? "right" : "bottom";
    const open = signal(false);
    const applied = signal<Filters>(none);
    const draft = signal<Filters>(none);
    const edit = (change: Partial<Filters>) => draft.set({ ...draft(), ...change });
    const show = () => {
      draft.set(applied());
      open.set(true);
    };
    const apply = () => {
      applied.set(draft());
      open.set(false);
      log(`applied ${active(draft()).join(", ") || "no filters"}`);
    };
    return (
      <Card icon="sheet" title="Filter the results" subtitle="Edited as a draft: the footer applies it, closing discards it">
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Trigger label="Filters" icon="list-filter" open={open()} onPress={show} />
          <Text style={{ flex: 1, fontSize: pointer ? 13 : 15, color: colors.muted, fontVariant: ["tabular-nums"] }}>{results(applied())} results</Text>
        </View>
        <If when={active(applied()).length > 0}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            <Each of={active(applied())}>{(label) => <Badge label={label()} tone="accent" />}</Each>
          </View>
        </If>
        <Sheet open={open()} side={side} closeOnSwipe={side === "bottom"} onOpenChange={changed("filters", (v) => open.set(v))} popupStyle={panel(side)} backdropStyle={backdrop}>
          <Head side={side} title="Filters" right={<If when={active(draft()).length > 0}><Badge label={`${active(draft()).length}`} tone="accent" /></If>} onClose={() => open.set(false)} />
          <Group title="Sort by">
            <Segmented
              size="small"
              options={[{ value: "relevance", label: "Relevance" }, { value: "newest", label: "Newest" }, { value: "price", label: "Price" }]}
              value={draft().sort}
              onChange={(sort) => edit({ sort })}
            />
          </Group>
          <Group title="Price">
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              <Each of={prices}>{(p) => <Button label={p().label} size="small" variant="secondary" selected={draft().price === p().value} onPress={() => edit({ price: p().value })} />}</Each>
            </View>
          </Group>
          <Group title="Show only">
            <View style={{ gap: 4 }}>
              <Each of={[["stock", "In stock"], ["shipping", "Free shipping"], ["sale", "On sale"]] as const}>
                {(row) => (
                  <View style={{ flexDirection: "row", alignItems: "center", minHeight: pointer ? 32 : 44 }}>
                    <Text style={{ flex: 1, fontSize: pointer ? 13 : 15, color: colors.text }}>{row()[1]}</Text>
                    <Toggle label={row()[1]} value={draft()[row()[0]]} onChange={(v) => edit({ [row()[0]]: v } as Partial<Filters>)} />
                  </View>
                )}
              </Each>
            </View>
          </Group>
          <Rule />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button label="Reset" variant="ghost" disabled={active(draft()).length === 0 && draft().sort === "relevance"} onPress={() => draft.set(none)} />
            <Button flex={1} label={`Show ${results(draft())} results`} onPress={apply} />
          </View>
        </Sheet>
      </Card>
    );
  }

  function ProfileSheet() {
    const side: Side = wide ? "right" : "bottom";
    const open = signal(false);
    const saved = signal({ name: "Mira Chen", username: "mira", bio: "Design lead. Motion, type and the space between." });
    const name = signal("");
    const username = signal("");
    const bio = signal("");
    const show = () => {
      name.set(saved().name);
      username.set(saved().username);
      bio.set(saved().bio);
      open.set(true);
    };
    const dirty = () => name() !== saved().name || username() !== saved().username || bio() !== saved().bio;
    const valid = () => name().trim().length > 0 && /^[a-z0-9_.]{2,20}$/.test(username()) && bio().length <= 160;
    const save = () => {
      saved.set({ name: name().trim(), username: username(), bio: bio() });
      open.set(false);
      log(`saved @${username()}`);
      void toast({ kind: "success", title: "Profile saved", description: `@${username()}` });
    };
    return (
      <Card icon="form" title="A form" subtitle="Save stays off until something changed and every field is valid">
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Avatar name={saved().name} size={pointer ? 36 : 44} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text style={{ fontSize: pointer ? 14 : 16, fontWeight: "600", color: colors.text }}>{saved().name}</Text>
            <Text style={{ numberOfLines: 1, fontSize: pointer ? 12 : 13, color: colors.muted }}>
              @{saved().username} · {saved().bio}
            </Text>
          </View>
          <Button label="Edit profile" variant="secondary" selected={open()} onPress={show} />
        </View>
        <Sheet open={open()} side={side} closeOnSwipe={side === "bottom"} onOpenChange={changed("profile", (v) => open.set(v))} popupStyle={panel(side)} backdropStyle={backdrop}>
          <Head side={side} title="Edit profile" onClose={() => open.set(false)} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <Avatar name={name() || "?"} size={52} />
            <Button label="Change photo" variant="secondary" size="small" onPress={() => log("change photo")} />
          </View>
          <Group title="Name">
            <Field value={name()} onChange={({ value }) => name.set(value)} placeholder="Your name" accessibilityLabel="Name" returnKeyType="next" />
          </Group>
          <Group title="Username">
            <Field prefix="@" value={username()} onChange={({ value }) => username.set(value.toLowerCase())} autoCapitalize="none" placeholder="name" accessibilityLabel="Username" />
            <If when={!/^[a-z0-9_.]{2,20}$/.test(username())}>
              <Text style={{ fontSize: 12, color: colors.danger }}>2 to 20 letters, digits, dots or underscores</Text>
            </If>
          </Group>
          <Group title="Bio">
            <Field multiline value={bio()} onChange={({ value }) => bio.set(value)} placeholder="A line about you" accessibilityLabel="Bio" />
            <Text style={{ alignSelf: "flex-end", fontSize: 12, color: bio().length > 160 ? colors.danger : colors.faint, fontVariant: ["tabular-nums"] }}>{bio().length} / 160</Text>
          </Group>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button flex={1} label="Cancel" variant="secondary" onPress={() => open.set(false)} />
            <Button flex={1} label="Save" disabled={!dirty() || !valid()} onPress={save} />
          </View>
        </Sheet>
      </Card>
    );
  }

  function Drawer() {
    const open = signal(false);
    const box = signal("inbox");
    const current = () => mailboxes.find((m) => m.id === box())!;
    return (
      <Card icon="sheet" title="A drawer" subtitle="Navigation from the leading edge; choosing closes it">
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Trigger label={current().label} icon="panel-left" open={open()} onPress={() => open.set(true)} />
          <Caption label={current().count ? `${current().count} unread` : "All read"} />
        </View>
        <Sheet open={open()} side="left" onOpenChange={changed("drawer", (v) => open.set(v))} popupStyle={{ ...panel("left"), width: Math.min(280, windowSize().width - 64), paddingHorizontal: 10, gap: 2 }} backdropStyle={backdrop}>
          <Text style={{ fontSize: pointer ? 12 : 13, fontWeight: "600", color: colors.faint, paddingHorizontal: 10, paddingBottom: 6 }}>Mailboxes</Text>
          <Each of={mailboxes}>
            {(m, i) => (
              <Appear index={i()}>
                <View
                  role="button"
                  accessibilityLabel={m().label}
                  accessibilityState={{ selected: box() === m().id }}
                  onPress={() => {
                    box.set(m().id);
                    open.set(false);
                    log(`mailbox ${m().label}`);
                  }}
                  hoverStyle={box() === m().id ? undefined : hovered()}
                  activeStyle={{ backgroundColor: alpha(colors.text, 0.1) }}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 12,
                    height: pointer ? 32 : 46,
                    paddingHorizontal: 10,
                    borderRadius: pointer ? 7 : 10,
                    backgroundColor: box() === m().id ? token("accent") : "transparent",
                    transitionProperty: "background-color",
                    transitionDuration: 120,
                  }}
                >
                  <LucideIcon name={m().icon} size={pointer ? 15 : 19} tint={box() === m().id ? colors.text : colors.muted} />
                  <Text style={{ flex: 1, fontSize: pointer ? 13 : 16, fontWeight: box() === m().id ? "600" : "400", color: colors.text }}>{m().label}</Text>
                  <If when={m().count}>
                    <Text style={{ fontSize: pointer ? 12 : 14, color: colors.faint, fontVariant: ["tabular-nums"] }}>{m().count}</Text>
                  </If>
                </View>
              </Appear>
            )}
          </Each>
        </Sheet>
      </Card>
    );
  }

  return <DemoPage cards={[FilterSheet, ProfileSheet, Drawer, Events]} />;
}
