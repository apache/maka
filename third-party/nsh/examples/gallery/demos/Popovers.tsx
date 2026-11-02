import { signal, Text, View } from "nsh";
import { type OpenChangeReason, Popover } from "nsh/base";
import { LucideIcon, type LucideIconName } from "../icons";
import { dismissToast, toast } from "../toast";
import { alpha, Badge, Button, Caption, Card, colors, DemoPage, hovered, PopIn, type PopupSide, popupSurface, Segmented, Stat, Toggle } from "../ui";
import { Avatar, createEvents, Field, pointer, Rule, tap, Trigger } from "./OverlayUi";

// Every popover here comes in with `PopIn` (the gallery's popup surface,
// fading and growing out of its trigger's edge); `nsh/base` draws none.

type Role = "Owner" | "Can edit" | "Can view";
type Person = { name: string; email: string; role: Role };

const reminders: { id: string; icon: LucideIconName; label: string; when: string }[] = [
  { id: "later", icon: "clock", label: "Later today", when: "18:00" },
  { id: "tomorrow", icon: "sunrise", label: "Tomorrow", when: "Thu 09:00" },
  { id: "week", icon: "calendar-days", label: "Next week", when: "Mon 09:00" },
];

/** A popover's title and what it is about. */
function Head(props: { title: string; note?: string }) {
  return (
    <View style={{ gap: 2 }}>
      <Text style={{ fontSize: pointer ? 14 : 16, fontWeight: "600", color: colors.text }}>{props.title}</Text>
      <If when={props.note}>
        <Text style={{ fontSize: pointer ? 12 : 13, color: colors.muted }}>{props.note}</Text>
      </If>
    </View>
  );
}

/**
 * Popovers of `nsh/base` as an app has them: a share panel with a field,
 * a list and a switch; a person's card from a mention; a reminder chosen
 * from a list, the app closing it (controlled); where one goes. A press
 * outside, Escape or back closes each; on phones the press only closes it.
 */
export function Popovers() {
  const { log, Events } = createEvents("Open a popover");
  const changed = (name: string) => ({ open, reason }: { open: boolean; reason: OpenChangeReason }) => log(`${name} ${open ? "opened" : "closed"} · ${reason}`);

  function Share() {
    const open = signal(false);
    const people = signal<Person[]>([
      { name: "Floyd Wang", email: "floyd@acme.dev", role: "Owner" },
      { name: "Mira Chen", email: "mira@acme.dev", role: "Can edit" },
      { name: "Ravi Patel", email: "ravi@acme.dev", role: "Can view" },
    ]);
    const invite = signal("");
    const anyone = signal(false);
    const copied = signal(false);
    let reset: ReturnType<typeof setTimeout> | undefined;
    const valid = () => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(invite().trim());
    const add = () => {
      if (!valid()) return;
      const email = invite().trim();
      const name = email.split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      people.set([...people(), { name, email, role: "Can view" }]);
      invite.set("");
      log(`invited ${email}`);
    };
    const toggleRole = (email: string) =>
      people.set(people().map((p) => (p.email === email && p.role !== "Owner" ? { ...p, role: p.role === "Can view" ? "Can edit" : "Can view" } : p)));
    const copy = () => {
      copied.set(true);
      clearTimeout(reset);
      reset = setTimeout(() => copied.set(false), 1600);
      void toast({ id: "share-link", kind: "success", title: "Link copied", description: anyone() ? "Anyone with it can view" : "Only people with access can open it" });
    };
    return (
      <Card icon="popover" title="Share a document" subtitle="A field, a list and a switch, anchored to its button">
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <LucideIcon name="file-text" size={pointer ? 18 : 22} tint={colors.muted} />
          <View style={{ flex: 1, gap: 1 }}>
            <Text style={{ fontSize: pointer ? 13 : 15, fontWeight: "500", color: colors.text }}>Q3 roadmap.md</Text>
            <Text style={{ fontSize: pointer ? 12 : 13, color: colors.faint }}>
              {people().length} people · {anyone() ? "anyone with the link" : "restricted"}
            </Text>
          </View>
          <Popover
            open={open()}
            onOpenChange={(e) => {
              open.set(e.open);
              changed("share")(e);
            }}
            placement="bottom"
            align="end"
            offset={6}
            margin={8}
            trigger={<Trigger label="Share" icon="share-2" open={open()} variant="primary" />}
          >
            <PopIn style={{ ...popupSurface(), width: pointer ? 320 : 330, padding: pointer ? 14 : 16, gap: 12 }}>
              <Head title="Share “Q3 roadmap”" note={`${people().length} people have access`} />
              <View style={{ flexDirection: "row", gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Field value={invite()} onChange={({ value }) => invite.set(value)} onSubmit={add} placeholder="Add people by email" keyboardType="email-address" autoCapitalize="none" returnKeyType="done" accessibilityLabel="Email to invite" />
                </View>
                <Button label="Invite" variant="secondary" disabled={!valid()} onPress={add} />
              </View>
              <View style={{ gap: pointer ? 6 : 8 }}>
                <Each of={people()} key={(p) => p.email}>
                  {(p) => (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                      <Avatar name={p().name} />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ numberOfLines: 1, fontSize: pointer ? 13 : 14, color: colors.text }}>{p().name}</Text>
                        <Text style={{ numberOfLines: 1, fontSize: pointer ? 11.5 : 12, color: colors.faint }}>{p().email}</Text>
                      </View>
                      <View
                        role="button"
                        accessibilityLabel={`${p().name}: ${p().role}`}
                        disabled={p().role === "Owner"}
                        onPress={() => toggleRole(p().email)}
                        hoverStyle={hovered()}
                        activeStyle={{ backgroundColor: alpha(colors.text, 0.09), transform: [{ scale: 0.96 }] }}
                        style={{ paddingHorizontal: 8, height: pointer ? 24 : 32, justifyContent: "center", borderRadius: 6, transitionProperty: "background-color, transform", transitionDuration: 120 }}
                      >
                        <Text style={{ fontSize: pointer ? 12 : 13, color: p().role === "Owner" ? colors.faint : colors.muted }}>{p().role}</Text>
                      </View>
                    </View>
                  )}
                </Each>
              </View>
              <Rule />
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <LucideIcon name={anyone() ? "globe" : "lock"} size={pointer ? 16 : 18} tint={anyone() ? colors.accent : colors.muted} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: pointer ? 13 : 14, color: colors.text }}>Anyone with the link</Text>
                  <Text style={{ fontSize: pointer ? 11.5 : 12, color: colors.faint }}>{anyone() ? "Can view, no sign-in" : "Only the people above"}</Text>
                </View>
                <Toggle label="Anyone with the link" value={anyone()} onChange={(v) => anyone.set(v)} />
              </View>
              <Button label={copied() ? "Copied" : "Copy link"} icon={copied() ? "check" : undefined} variant="secondary" selected={copied()} onPress={copy} />
            </PopIn>
          </Popover>
        </View>
      </Card>
    );
  }

  function Profile() {
    const open = signal(false);
    const following = signal(false);
    return (
      <Card icon="popover" title="A person's card" subtitle={`${tap} a mention: who it is, and what to do next`}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Avatar name="Mira Chen" size={pointer ? 24 : 30} />
          <Popover
            open={open()}
            onOpenChange={(e) => {
              open.set(e.open);
              changed("profile")(e);
            }}
            placement="top"
            align="start"
            offset={6}
            margin={8}
            trigger={<Trigger label="@Mira Chen" open={open()} variant="ghost" ink={colors.accent} />}
          >
            <PopIn side="top" style={{ ...popupSurface(), width: pointer ? 280 : 300, padding: pointer ? 14 : 16, gap: 12 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                <Avatar name="Mira Chen" size={44} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ fontSize: pointer ? 15 : 17, fontWeight: "600", color: colors.text }}>Mira Chen</Text>
                  <Text style={{ fontSize: pointer ? 12 : 13, color: colors.muted }}>Design lead · Platform</Text>
                </View>
                <If when={following()}>
                  <Badge label="Following" tone="accent" />
                </If>
              </View>
              <Text style={{ fontSize: pointer ? 13 : 14, lineHeight: pointer ? 18 : 20, color: colors.text }}>Shapes the components teams build on. Ask about motion and type.</Text>
              <View style={{ flexDirection: "row", gap: 14 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                  <LucideIcon name="map-pin" size={13} tint={colors.faint} />
                  <Text style={{ fontSize: 12, color: colors.muted }}>Shanghai</Text>
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                  <LucideIcon name="clock" size={13} tint={colors.faint} />
                  <Text style={{ fontSize: 12, color: colors.muted }}>16:42 local time</Text>
                </View>
              </View>
              <View style={{ flexDirection: "row" }}>
                <Stat label="Projects" value="12" width="33%" />
                <Stat label="Reviews" value="248" width="33%" />
                <Stat label="Followers" value={following() ? "1,205" : "1,204"} width="33%" />
              </View>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Button
                  flex={1}
                  label={following() ? "Following" : "Follow"}
                  icon={following() ? "check" : "plus"}
                  variant={following() ? "secondary" : "primary"}
                  onPress={() => {
                    following.set(!following());
                    log(following() ? "followed Mira Chen" : "unfollowed Mira Chen");
                  }}
                />
                <Button
                  flex={1}
                  label="Message"
                  variant="secondary"
                  onPress={() => {
                    open.set(false);
                    log("message to Mira Chen");
                  }}
                />
              </View>
            </PopIn>
          </Popover>
          <Text style={{ flex: 1, fontSize: pointer ? 13 : 15, color: colors.muted }}>mentioned you in Q3 roadmap</Text>
        </View>
      </Card>
    );
  }

  function Reminder() {
    const open = signal(false);
    const chosen = signal<string | null>(null);
    const current = () => reminders.find((r) => r.id === chosen());
    const choose = (id: string | null) => {
      chosen.set(id);
      // The app closes it: a controlled popover reports no reason for this.
      open.set(false);
      log(id ? `reminder ${current()!.label} · ${current()!.when}` : "reminder cleared");
      dismissToast("reminder");
      if (id) void toast({ id: "reminder", kind: "info", title: `Reminder set for ${current()!.when}`, description: "Review the Q3 roadmap" });
    };
    return (
      <Card icon="popover" title="Chosen from a list" subtitle="Controlled: choosing closes it, and the trigger shows the choice">
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Popover
            open={open()}
            onOpenChange={(e) => {
              open.set(e.open);
              changed("reminder")(e);
            }}
            align="start"
            offset={6}
            margin={8}
            trigger={<Trigger label={current() ? `${current()!.label} · ${current()!.when}` : "Remind me"} icon={current() ? "bell-ring" : "alarm-clock"} open={open()} />}
          >
            <PopIn style={{ ...popupSurface(), width: pointer ? 240 : 280 }}>
              <Text style={{ fontSize: pointer ? 11 : 13, fontWeight: "600", color: colors.faint, paddingHorizontal: 8, paddingTop: 6, paddingBottom: 4 }}>Remind me</Text>
              <Each of={reminders}>
                {(r) => (
                  <View
                    role="button"
                    accessibilityState={{ selected: chosen() === r().id }}
                    onPress={() => choose(r().id)}
                    hoverStyle={hovered()}
                    activeStyle={{ backgroundColor: alpha(colors.text, 0.1) }}
                    style={{ flexDirection: "row", alignItems: "center", gap: 10, height: pointer ? 28 : 46, paddingHorizontal: 8, borderRadius: pointer ? 6 : 10 }}
                  >
                    <LucideIcon name={r().icon} size={pointer ? 14 : 18} tint={colors.muted} />
                    <Text style={{ flex: 1, fontSize: pointer ? 13 : 16, color: colors.text }}>{r().label}</Text>
                    <Text style={{ fontSize: pointer ? 11.5 : 14, color: chosen() === r().id ? colors.accent : colors.faint }}>{r().when}</Text>
                  </View>
                )}
              </Each>
              <If when={chosen()}>
                <View style={{ height: 1, marginVertical: 4, marginHorizontal: 4, backgroundColor: colors.line }} />
                <View
                  role="button"
                  onPress={() => choose(null)}
                  hoverStyle={hovered()}
                  activeStyle={{ backgroundColor: alpha(colors.text, 0.1) }}
                  style={{ flexDirection: "row", alignItems: "center", gap: 10, height: pointer ? 28 : 46, paddingHorizontal: 8, borderRadius: pointer ? 6 : 10 }}
                >
                  <LucideIcon name="circle-x" size={pointer ? 14 : 18} tint={colors.danger} />
                  <Text style={{ fontSize: pointer ? 13 : 16, color: colors.danger }}>Clear reminder</Text>
                </View>
              </If>
            </PopIn>
          </Popover>
        </View>
      </Card>
    );
  }

  function Placement() {
    const side = signal<PopupSide>("bottom");
    const align = signal<"start" | "center" | "end">("center");
    return (
      <Card icon="components" title="Where it goes" subtitle="The side and the alignment; it flips where there is no room">
        <Segmented
          size="small"
          options={[{ value: "top", label: "Top" }, { value: "bottom", label: "Bottom" }, { value: "left", label: "Left" }, { value: "right", label: "Right" }]}
          value={side()}
          onChange={(v) => side.set(v)}
        />
        <Segmented
          size="small"
          options={[{ value: "start", label: "Start" }, { value: "center", label: "Center" }, { value: "end", label: "End" }]}
          value={align()}
          onChange={(v) => align.set(v)}
        />
        <View style={{ alignItems: "center", paddingVertical: pointer ? 40 : 28 }}>
          <Popover placement={side()} align={align()} offset={8} margin={8} onOpenChange={changed("placed")} trigger={<Trigger label={`${side()} · ${align()}`} icon="map-pin" />}>
            <PopIn side={side()} style={{ ...popupSurface(), padding: 12, gap: 4, maxWidth: 220 }}>
              <Text style={{ fontSize: 13, fontWeight: "600", color: colors.text }}>
                Placed {side()} · {align()}
              </Text>
              <Text style={{ fontSize: 12, color: colors.muted }}>It grows out of the edge that faces its trigger.</Text>
            </PopIn>
          </Popover>
        </View>
        <Caption label={pointer ? "Scroll the page: it follows its trigger" : "A tap outside only closes it"} />
      </Card>
    );
  }

  return <DemoPage cards={[Share, Profile, Reminder, Placement, Events]} />;
}
