import { horizontalSizeClass, type JSX, platform, Scroll, signal, Text, untracked, View } from "nsh";
import { type ColumnVisibility, createNavStack, Input, NavPage, NavStack, SplitView } from "nsh/base";
import { BackHandler } from "nsh/mobile";
import { Icon, LucideIcon, type LucideIconName } from "../icons";
import { nav } from "../nav";
import { alpha, colors, density, focusRing, header, hovered, PageHeader, radius, terminal, ToolButton } from "../ui";

// `nsh/base`'s `SplitView`: a mail app in three columns, each a `NavStack`
// of its own: the mailboxes, a mailbox's messages and the message, which
// pushes a reply. On iOS and iPadOS the columns are a `UISplitViewController`'s
// (the floating sidebar, the swipe from the edge, the system's sidebar and back
// buttons); elsewhere they stand side by side. Where the window is compact one
// column shows: a selection brings the next one in front, and back returns.
// The look is the gallery's: the sidebar on its own surface, a hairline
// between the columns, a neutral selection; the columns resize by their edges.

type Mailbox = { id: string; title: string; icon: LucideIconName };

const MAILBOXES: Mailbox[] = [
  { id: "inbox", title: "Inbox", icon: "inbox" },
  { id: "starred", title: "Starred", icon: "star" },
  { id: "drafts", title: "Drafts", icon: "file-text" },
  { id: "sent", title: "Sent", icon: "send" },
  { id: "archive", title: "Archive", icon: "archive" },
];

type Message = {
  id: number;
  mailbox: string;
  from: string;
  subject: string;
  time: string;
  unread?: boolean;
  body: string[];
};

const MESSAGES: Message[] = [
  {
    id: 1,
    mailbox: "inbox",
    from: "Maya Chen",
    subject: "Design review on Thursday",
    time: "9:41",
    unread: true,
    body: [
      "Hi, the review moved to Thursday at 10. I attached the latest flows for the onboarding screens.",
      "Could you look at the empty states before then? The sidebar collapses differently on phones now.",
    ],
  },
  {
    id: 2,
    mailbox: "inbox",
    from: "Lucas Moreau",
    subject: "Release notes for 0.6",
    time: "8:15",
    unread: true,
    body: ["The draft notes are in the shared folder.", "Split views, size classes and the new gallery demos are in; the rest is fixes."],
  },
  {
    id: 3,
    mailbox: "inbox",
    from: "Aiko Tanaka",
    subject: "Lunch next week?",
    time: "Yesterday",
    body: ["I'll be in town from Tuesday. Wednesday works best for me, anywhere near the office."],
  },
  {
    id: 4,
    mailbox: "starred",
    from: "Maya Chen",
    subject: "Brand colors, final",
    time: "Mon",
    body: ["Attached are the final brand colors, with the dark theme's tones checked for contrast."],
  },
  {
    id: 5,
    mailbox: "drafts",
    from: "Me",
    subject: "Quarterly update",
    time: "Sun",
    body: ["Shipped this quarter: the new navigation, faster lists and the first desktop release."],
  },
  {
    id: 6,
    mailbox: "sent",
    from: "Me",
    subject: "Re: Release notes for 0.6",
    time: "Sat",
    body: ["Looks good. I'd lead with split views and keep the fixes short."],
  },
  {
    id: 7,
    mailbox: "archive",
    from: "Jonas Berg",
    subject: "Conference badges",
    time: "Mar 2",
    body: ["Your badge is at the front desk. The talks start at nine in hall B."],
  },
];

const messagesIn = (mailbox: string) => MESSAGES.filter((m) => m.mailbox === mailbox);

/** iOS shows the system's headers and buttons; elsewhere the gallery's
 * header slot does, with the way back where one column shows. */
const ios = platform.os === "ios";
/** Android shows the system's header: the way back between columns goes
 * in its leading slot. */
const android = platform.os === "android";
/** A hairline after a column, where the columns stand side by side
 * (iPadOS draws its own). */
const divider = (color?: string) => (ios || !color ? {} : { borderEndWidth: 1, borderEndColor: color });

/** A header button: an icon, and a label where it says where it goes. */
function HeaderButton(props: { icon: "back" | "sidebar"; label: string; title?: string; onPress: () => void }) {
  return (
    <View
      onPress={props.onPress}
      role="button"
      accessibilityLabel={props.label}
      hitSlop={6}
      hoverStyle={hovered()}
      activeStyle={{ backgroundColor: alpha(colors.text, 0.09) }}
      focusVisibleStyle={focusRing()}
      style={{ height: 28, flexDirection: "row", alignItems: "center", gap: 2, paddingStart: 4, paddingEnd: props.title ? 8 : 4, borderRadius: radius.control }}
    >
      {!terminal && <Icon name={props.icon} size={18} tint={colors.text} />}
      {(props.title || terminal) && <Text style={{ fontSize: 13, fontWeight: "500", color: colors.text }}>{props.title ?? props.label}</Text>}
    </View>
  );
}

/** A mailbox of the sidebar: its icon, its title and its unread count. */
function MailboxRow(props: { mailbox: Mailbox; selected: boolean; onPress: () => void }) {
  const unread = () => messagesIn(props.mailbox.id).filter((m) => m.unread).length;
  return (
    <View
      onPress={props.onPress}
      role="button"
      accessibilityLabel={props.mailbox.title}
      accessibilityState={{ selected: props.selected }}
      hoverStyle={props.selected ? undefined : hovered()}
      focusVisibleStyle={focusRing()}
      style={{
        height: density.row - (platform.desktop ? 6 : 0),
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 10,
        borderRadius: radius.control,
        backgroundColor: props.selected ? alpha(colors.text, 0.07) : "transparent",
      }}
    >
      {!terminal && <LucideIcon name={props.mailbox.icon} size={16} tint={props.selected ? colors.text : colors.muted} />}
      <Text style={{ flex: 1, numberOfLines: 1, fontSize: density.body, fontWeight: props.selected ? "600" : "500", color: colors.text }}>{props.mailbox.title}</Text>
      {unread() > 0 && <Text style={{ fontSize: density.note, fontVariant: ["tabular-nums"], color: colors.muted }}>{String(unread())}</Text>}
    </View>
  );
}

/** A message of a mailbox: who sent it and when, its subject, the start of
 * its text; a dot while unread. */
function MessageRow(props: { message: Message; selected: boolean; onPress: () => void }) {
  const m = props.message;
  return (
    <View
      onPress={props.onPress}
      role="button"
      accessibilityLabel={`${m.from}, ${m.subject}`}
      accessibilityState={{ selected: props.selected }}
      hoverStyle={props.selected ? undefined : hovered()}
      focusVisibleStyle={focusRing()}
      style={{
        flexDirection: "row",
        gap: 8,
        paddingVertical: 10,
        paddingEnd: 12,
        paddingStart: 6,
        borderRadius: radius.control,
        backgroundColor: props.selected ? alpha(colors.text, 0.07) : "transparent",
      }}
    >
      <View style={{ width: 10, paddingTop: 6, alignItems: "center" }}>
        {m.unread && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.text }} />}
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ flex: 1, numberOfLines: 1, fontSize: density.body, fontWeight: m.unread ? "600" : "500", color: colors.text }}>{m.from}</Text>
          <Text style={{ fontSize: density.note, fontVariant: ["tabular-nums"], color: colors.faint }}>{m.time}</Text>
        </View>
        <Text style={{ numberOfLines: 1, fontSize: density.note + 1, fontWeight: m.unread ? "500" : "400", color: colors.text }}>{m.subject}</Text>
        <Text style={{ numberOfLines: 2, fontSize: density.note, lineHeight: density.note + 5, color: colors.muted }}>{m.body[0]}</Text>
      </View>
    </View>
  );
}

/** A column's page: the system's header on iOS and Android, the gallery's
 * header slot elsewhere, and the column's surface under its content. `left` leads the header slot, `systemLeft`
 * the system's header (beside its own back and sidebar buttons). */
function Column(props: {
  title: string;
  left?: JSX.Element;
  systemLeft?: JSX.Element;
  right?: JSX.Element;
  surface: string;
  /** The hairline after the column's body, where the columns stand side by side. */
  border?: string;
  /** The sidebar: its header on its surface. */
  sidebar?: boolean;
  children: JSX.Element;
}) {
  return (
    <NavPage
      title={props.title}
      // The hairline runs down the whole column, its header included.
      style={{ backgroundColor: props.surface }}
      {...header}
      headerLeft={ios || android ? props.systemLeft : undefined}
      headerRight={ios || android ? props.right : undefined}
      // The sidebar's header is on its surface, without a hairline; the
      // others take the page's, over a hairline.
      header={<PageHeader title={props.title} root left={props.left} right={props.right} background={props.sidebar ? props.surface : undefined} />}
    >
      <View style={{ flex: 1, ...divider(props.border) }}>{props.children}</View>
    </NavPage>
  );
}

export function SplitViewDemo() {
  const visibility = signal<ColumnVisibility>("automatic");
  const mailbox = signal("inbox");
  const selected = signal<number>(MESSAGES[0].id);
  const draft = signal("");
  const sidebarNav = createNavStack(["mailboxes"]);
  const listNav = createNavStack(["messages"]);
  const messageNav = createNavStack<"message" | "reply">(["message"]);
  // One column shows where the window is compact: a selection brings the
  // next column in front, back returns to the one before.
  const compact = () => horizontalSizeClass() === "compact";
  const sidebarShown = () => ["automatic", "all"].includes(visibility());
  const openMailbox = (id: string) => {
    mailbox.set(id);
    selected.set(messagesIn(id)[0]?.id ?? -1);
    messageNav.popToRoot();
    if (compact()) visibility.set("doubleColumn");
  };
  const openMessage = (id: number) => {
    selected.set(id);
    messageNav.popToRoot();
    if (compact()) visibility.set("detailOnly");
  };
  const message = () => MESSAGES.find((m) => m.id === selected());
  const box = () => MAILBOXES.find((b) => b.id === mailbox()) ?? MAILBOXES[0];
  // Android's back button steps back a column where one shows, once the
  // column's own stack has nothing to pop.
  BackHandler.on("press", () => {
    if (!compact()) return false;
    const shown = untracked(visibility);
    if (shown === "detailOnly" && untracked(messageNav.routes).length === 1) {
      visibility.set("doubleColumn");
      return true;
    }
    if (shown === "doubleColumn") {
      visibility.set("all");
      return true;
    }
    return false;
  });
  // The way back where one column shows (iOS has the system's), and the
  // sidebar's button where the columns stand side by side (iPadOS has its own).
  const back = (title: string, to: ColumnVisibility) =>
    !ios && compact() ? <HeaderButton icon="back" label={`Back to ${title}`} title={title} onPress={() => visibility.set(to)} /> : undefined;
  const sidebarToggle = () =>
    !ios && !compact() ? <ToolButton icon="sidebar" label={sidebarShown() ? "Hide the mailboxes" : "Show the mailboxes"} on={sidebarShown()} onPress={() => visibility.set(sidebarShown() ? "doubleColumn" : "all")} /> : undefined;
  // On a phone the gallery's own page is behind the demo: its way back
  // leads the mailboxes.
  const galleryBack = () =>
    nav.routes().length > 1 ? <HeaderButton icon="back" label="Back to the gallery" title="Gallery" onPress={() => nav.pop()} /> : undefined;
  return (
    <SplitView
      style={{ flex: 1, backgroundColor: colors.background }}
      columnVisibility={visibility()}
      onColumnVisibilityChange={({ columnVisibility }) => visibility.set(columnVisibility)}
      sidebar={
                <NavStack state={sidebarNav}>
          {() => (
            <Column title="Mailboxes" sidebar surface={colors.sidebar} border={colors.sidebarBorder} left={galleryBack()} systemLeft={galleryBack()}>
              <Scroll style={{ flex: 1 }}>
                <View style={{ padding: 8, gap: 2 }}>
                  {MAILBOXES.map((b) => (
                    <MailboxRow mailbox={b} selected={!compact() && mailbox() === b.id} onPress={() => openMailbox(b.id)} />
                  ))}
                </View>
              </Scroll>
            </Column>
          )}
        </NavStack>
      }
      content={
                <NavStack state={listNav}>
          {() => (
            <Column
              title={box().title}
              surface={colors.background}
              border={colors.line}
              left={back("Mailboxes", "all") ?? sidebarToggle()}
              systemLeft={back("Mailboxes", "all")}
            >
              <Scroll style={{ flex: 1 }}>
                <View style={{ padding: 8, gap: 2 }}>
                <Each of={messagesIn(mailbox())}>
                  {(m) => <MessageRow message={m()} selected={!compact() && selected() === m().id} onPress={() => openMessage(m().id)} />}
                </Each>
                <If when={messagesIn(mailbox()).length === 0}>
                  <Text style={{ padding: 24, textAlign: "center", fontSize: density.body, color: colors.muted }}>No messages</Text>
                </If>
                </View>
              </Scroll>
            </Column>
          )}
        </NavStack>
      }
      detail={
        <NavStack state={messageNav}>
          {(route) =>
            route === "message" ? (
              <Column
                title={message()?.subject ?? "Message"}
                surface={colors.background}
                left={back(box().title, "doubleColumn")}
                systemLeft={back(box().title, "doubleColumn")}
                right={
                  message() && (
                    <ToolButton
                      glyph={terminal ? undefined : <LucideIcon name="undo-2" size={16} tint={colors.muted} />}
                      icon={terminal ? "back" : undefined}
                      label="Reply"
                      onPress={() => messageNav.push("reply")}
                    />
                  )
                }
              >
                <If when={message()} else={<Text style={{ margin: 24, textAlign: "center", fontSize: density.body, color: colors.muted }}>No message selected</Text>}>
                  {(m) => (
                    <Scroll style={{ flex: 1 }}>
                      <View style={{ paddingHorizontal: platform.desktop ? 28 : 18, paddingVertical: 20, gap: 16, maxWidth: 720 }}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                          <View style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: alpha(colors.text, 0.08) }}>
                            <Text style={{ fontSize: 14, fontWeight: "600", color: colors.muted }}>{m().from.split(" ").map((w) => w[0]).join("").slice(0, 2)}</Text>
                          </View>
                          <View style={{ flex: 1, gap: 2 }}>
                            <Text style={{ fontSize: density.body, fontWeight: "600", color: colors.text }}>{m().from}</Text>
                            <Text style={{ fontSize: density.note, color: colors.muted }}>{`To me · ${m().time}`}</Text>
                          </View>
                        </View>
                        <View style={{ height: 1, backgroundColor: colors.line }} />
                        <View style={{ gap: 12 }}>
                          {m().body.map((p) => (
                            <Text style={{ fontSize: platform.desktop ? 14 : 16, lineHeight: platform.desktop ? 21 : 24, color: colors.text }}>{p}</Text>
                          ))}
                        </View>
                      </View>
                    </Scroll>
                  )}
                </If>
              </Column>
            ) : (
              <Column title="Reply" surface={colors.background} left={<HeaderButton icon="back" label="Back to the message" title="Message" onPress={() => messageNav.pop()} />}>
                <View style={{ flex: 1, padding: platform.desktop ? 20 : 16, gap: 10 }}>
                  <Text style={{ fontSize: density.note, color: colors.muted }}>{`To ${message()?.from ?? ""}`}</Text>
                  {/* What is typed stays as the window narrows and widens: the column keeps its page. */}
                  <Input
                    multiline
                    value={draft()}
                    onChange={({ value }) => draft.set(value)}
                    placeholder="Write a reply"
                    accessibilityLabel="Reply text"
                    style={{ flex: 1, padding: 12, fontSize: density.body, color: colors.text, backgroundColor: colors.field, borderWidth: 1, borderColor: colors.fieldBorder, borderRadius: radius.control }}
                  />
                </View>
              </Column>
            )
          }
        </NavStack>
      }
    />
  );
}
